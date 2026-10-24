import type { Context, Config } from "@netlify/functions";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const NOTION_VERSION = "2022-06-28";
const PROG_DB = "df4e3905-2eef-48ec-93ac-be17ff30fdc4";
const PARADAS_DB = "66ed6629-11b0-4326-bbab-f8eb448fadb8";

const rt = (t: any) => ({ rich_text: [{ text: { content: String(t ?? "") } }] });
const title = (t: any) => ({ title: [{ text: { content: String(t ?? "") } }] });
const sel = (n: any) => (n ? { select: { name: n } } : { select: null });
const num = (n: any) => {
  const v = n === "" || n === null || n === undefined ? null : Number(n);
  return { number: v === null || isNaN(v) ? null : v };
};

function diffHoras(ini: string, fim: string): number | null {
  if (!ini || !fim) return null;
  const [ih, im] = ini.split(":").map(Number);
  const [fh, fm] = fim.split(":").map(Number);
  if ([ih, im, fh, fm].some(isNaN)) return null;
  let d = fh * 60 + fm - (ih * 60 + im);
  if (d < 0) d += 1440;
  return Math.round((d / 60) * 100) / 100;
}
function turnoDe(hhmm: string): string {
  const h = parseInt((hhmm || "0").split(":")[0], 10);
  if (h >= 6 && h < 14) return "1º Turno";
  if (h >= 14 && h < 22) return "2º Turno";
  return "3º Turno";
}


// ---- Senhas de acesso ----
// Hash SHA-256 (com sal) das senhas. Podem ser trocadas definindo as variáveis de ambiente
// PCP_SENHA e APONTADOR_SENHA no Netlify (texto puro); se definidas, têm prioridade.
const SALT = "bv-salt-2026:";
const HASH_PCP = "cf475d6e4e7b1a7ff68c1a6689b9c12a610b7e93d37fc660215db3cb812c1b02";
const HASH_APONT = "8cdf4dd53e6685c39065eb46e264061bab4bf12b653561912ee642f364b73118";
async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function senhaOk(senha: string, papel: "pcp" | "apontador"): Promise<boolean> {
  if (!senha) return false;
  const h = await sha256(SALT + senha);
  const envPcp = Netlify.env.get("PCP_SENHA");
  const envAp = Netlify.env.get("APONTADOR_SENHA");
  const okPcp = envPcp ? senha === envPcp : h === HASH_PCP;
  const okAp = envAp ? senha === envAp : h === HASH_APONT;
  return papel === "pcp" ? okPcp : okPcp || okAp; // PCP também acessa o Apontamento
}
const ACOES_PCP = ["programar", "editar_programacao", "excluir_programacao"];

async function notion(path: string, method: string, token: string, body: any) {
  const res = await fetch(`https://api.notion.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Notion ${method} ${path} failed (${res.status}): ${text}`);
  return text ? JSON.parse(text) : null;
}

export default async (req: Request, _ctx: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });
  const token = Netlify.env.get("NOTION_TOKEN");
  const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", ...CORS } });
  if (!token) return json({ error: "NOTION_TOKEN not configured" }, 500);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }
  const { action, payload, senha } = body || {};
  const p = payload || {};

  const papel = action === "login" ? (p.papel === "pcp" ? "pcp" : "apontador") : ACOES_PCP.includes(action) ? "pcp" : "apontador";
  if (!(await senhaOk(senha, papel))) return json({ error: "Senha incorreta ou ausente", auth: true }, 401);
  if (action === "login") return json({ ok: true });

  try {
    // ---- PCP: montar / ajustar programação ----
    if (action === "programar") {
      if (!p.maquina || !p.data || !p.produto || !p.qtdProgramada) throw new Error("Campos obrigatórios: Máquina, Data, Produto e Quantidade");
      const page = await notion("/v1/pages", "POST", token, {
        parent: { type: "database_id", database_id: PROG_DB },
        properties: {
          "Máquina": title(p.maquina),
          Data: { date: { start: p.data } },
          Produto: rt(p.produto),
          "Qtd a Produzir": num(p.qtdProgramada),
          "Início Previsto": rt(p.inicioPrevisto || ""),
          "Término Previsto": rt(p.terminoPrevisto || ""),
          "Secagem (min)": num(p.secagemMin),
          Status: sel("Não iniciado"),
        },
      });
      return json({ ok: true, id: page.id });
    }
    if (action === "editar_programacao") {
      if (!p.id) throw new Error("id é obrigatório");
      const props: any = {};
      if (p.maquina !== undefined) props["Máquina"] = title(p.maquina);
      if (p.data) props.Data = { date: { start: p.data } };
      if (p.produto !== undefined) props.Produto = rt(p.produto);
      if (p.qtdProgramada !== undefined) props["Qtd a Produzir"] = num(p.qtdProgramada);
      if (p.inicioPrevisto !== undefined) props["Início Previsto"] = rt(p.inicioPrevisto);
      if (p.terminoPrevisto !== undefined) props["Término Previsto"] = rt(p.terminoPrevisto);
      if (p.secagemMin !== undefined) props["Secagem (min)"] = num(p.secagemMin);
      await notion(`/v1/pages/${p.id}`, "PATCH", token, { properties: props });
      return json({ ok: true });
    }
    if (action === "excluir_programacao") {
      if (!p.id) throw new Error("id é obrigatório");
      await notion(`/v1/pages/${p.id}`, "PATCH", token, { archived: true });
      return json({ ok: true });
    }

    // ---- Apontador: status, OP, horas reais, quantidade ----
    if (action === "iniciar_producao") {
      if (!p.id || !p.opNumero) throw new Error("Informe o Nº da Ordem de Produção");
      await notion(`/v1/pages/${p.id}`, "PATCH", token, {
        properties: { "Nº OP": rt(p.opNumero), "Início Real": rt(p.inicioReal || ""), Status: sel("Em andamento") },
      });
      return json({ ok: true });
    }
    if (action === "concluir_producao") {
      if (!p.id || p.qtdProduzida === undefined || p.qtdProduzida === "") throw new Error("Informe a quantidade de sacos produzidos");
      await notion(`/v1/pages/${p.id}`, "PATCH", token, {
        properties: { "Término Real": rt(p.terminoReal || ""), "Qtd Produzida": num(p.qtdProduzida), Status: sel("Concluído") },
      });
      return json({ ok: true });
    }
    if (action === "status_producao") {
      // permite corrigir o status manualmente (ex.: voltar para Não iniciado)
      if (!p.id || !p.status) throw new Error("id e status são obrigatórios");
      await notion(`/v1/pages/${p.id}`, "PATCH", token, { properties: { Status: sel(p.status) } });
      return json({ ok: true });
    }

    // ---- Horas paradas ----
    if (action === "registrar_parada") {
      if (!p.maquina || !p.motivo || !p.data || !p.horaInicio || !p.horaTermino) throw new Error("Campos obrigatórios: Máquina, Data, Motivo, Início e Término");
      const horas = diffHoras(p.horaInicio, p.horaTermino);
      const page = await notion("/v1/pages", "POST", token, {
        parent: { type: "database_id", database_id: PARADAS_DB },
        properties: {
          "Máquina": title(p.maquina),
          Data: { date: { start: p.data } },
          Turno: sel(turnoDe(p.horaInicio)),
          Motivo: sel(p.motivo),
          "Hora Início": rt(p.horaInicio),
          "Hora Término": rt(p.horaTermino),
          "Horas Paradas": num(horas),
          Status: sel("Encerrada"),
          Observações: rt(p.obs || ""),
          "Local ID": rt(`parada-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
        },
      });
      return json({ ok: true, id: page.id, horas });
    }

    throw new Error(`Ação desconhecida: ${action}`);
  } catch (e: any) {
    return json({ error: String((e && e.message) || e) }, 400);
  }
};

export const config: Config = { path: "/api/prog-submit" };
