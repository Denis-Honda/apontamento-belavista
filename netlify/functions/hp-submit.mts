import type { Context, Config } from "@netlify/functions";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const NOTION_VERSION = "2022-06-28";
const PARADAS_DB = "66ed6629-11b0-4326-bbab-f8eb448fadb8";
const FALTAS_DB = "ca7bd838-5ee7-4b4f-ac0a-92a045d62416";
const CONFIG_DB = "422ad3bc-da5e-81bf-aef3-f8c686add659";

const MAQUINAS = ["Máquina 00", "Máquina 01", "Máquina 02", "Máquina 03", "Máquina 04", "Máquina 05", "Máquina 06"];
const TURNOS = ["1º Turno", "2º Turno", "3º Turno"];
const MOTIVOS_PADRAO = ["Falta de energia", "Falta de funcionário", "Falta de Matéria-prima", "Falta de Mecânico", "Falta de Embalagem", "Limpeza", "Manutenção", "Máquina quebrada", "Reunião", "Saída Médico / Particular", "Sem demanda", "Trator quebrado", "Treinamento"];
const FUNCOES_PADRAO = ["Envasador(a)", "Operador(a) de Máquina", "Operador(a) de Trator", "Operador(a) Empilhadeira", "Etiquetador(a)", "Preparador(a) de Aditivos"];

const rt = (t: any) => ({ rich_text: [{ text: { content: String(t ?? "") } }] });
const title = (t: any) => ({ title: [{ text: { content: String(t ?? "") } }] });
const sel = (n: any) => (n ? { select: { name: n } } : { select: null });
const num = (n: any) => {
  const v = n === "" || n === null || n === undefined ? null : Number(n);
  return { number: v === null || isNaN(v) ? null : v };
};
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATA = /^\d{4}-\d{2}-\d{2}$/;
const semTracos = (s: string) => String(s || "").replace(/-/g, "").toLowerCase();

function diffHoras(ini: string, fim: string): number {
  const [ih, im] = ini.split(":").map(Number);
  const [fh, fm] = fim.split(":").map(Number);
  let d = fh * 60 + fm - (ih * 60 + im);
  if (d < 0) d += 1440; // término no dia seguinte (turno da noite)
  return Math.round((d / 60) * 100) / 100;
}
function turnoDe(hhmm: string): string {
  const h = parseInt(hhmm.split(":")[0], 10);
  if (h >= 6 && h < 14) return "1º Turno";
  if (h >= 14 && h < 22) return "2º Turno";
  return "3º Turno";
}

// ---- Senhas ----
// Duas senhas: "lancar" (apontador) e "config" (responsável). A senha de configurações também libera o lançamento.
// Guardamos só o hash SHA-256 (com sal). Podem ser trocadas no Netlify definindo as variáveis
// LANCAMENTO_SENHA e CONFIG_SENHA (texto puro); se existirem, têm prioridade.
const SALT = "bv-salt-2026:";
const HASH_CONFIG = "cf475d6e4e7b1a7ff68c1a6689b9c12a610b7e93d37fc660215db3cb812c1b02";
const HASH_LANCAR = "8cdf4dd53e6685c39065eb46e264061bab4bf12b653561912ee642f364b73118";
async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function senhaOk(senha: string, papel: "lancar" | "config"): Promise<boolean> {
  if (!senha) return false;
  const h = await sha256(SALT + senha);
  const envC = Netlify.env.get("CONFIG_SENHA");
  const envL = Netlify.env.get("LANCAMENTO_SENHA");
  const okC = envC ? senha === envC : h === HASH_CONFIG;
  const okL = envL ? senha === envL : h === HASH_LANCAR;
  return papel === "config" ? okC : okC || okL;
}
const ACOES_CONFIG = ["salvar_config"];

async function notion(path: string, method: string, token: string, body: any) {
  const res = await fetch(`https://api.notion.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Notion ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function listaConfig(token: string, tipo: "Motivo" | "Função") {
  const rows: any[] = [];
  let cursor: string | undefined;
  do {
    const d = await notion(`/v1/databases/${CONFIG_DB}/query`, "POST", token, {
      page_size: 100,
      start_cursor: cursor,
      filter: { property: "Tipo", select: { equals: tipo } },
    });
    rows.push(...(d.results || []));
    cursor = d.has_more ? d.next_cursor : undefined;
  } while (cursor);
  return rows.map((pg) => ({
    id: pg.id as string,
    nome: ((pg.properties?.Nome?.title || []) as any[]).map((t) => t.plain_text).join(""),
    ordem: (pg.properties?.Ordem?.number ?? 9999) as number,
  }));
}
// Lista válida atual (config do Notion; se vazia/indisponível, usa o padrão)
async function nomesValidos(token: string, tipo: "Motivo" | "Função"): Promise<string[]> {
  try {
    const rows = (await listaConfig(token, tipo)).sort((a, b) => a.ordem - b.ordem).map((r) => r.nome);
    if (rows.length) return rows;
  } catch { /* usa padrão */ }
  return tipo === "Motivo" ? MOTIVOS_PADRAO : FUNCOES_PADRAO;
}

// Só mexe em páginas que pertencem aos bancos esperados
async function paginaDoBanco(token: string, id: string, dbId: string) {
  const pg = await notion(`/v1/pages/${id}`, "GET", token, undefined);
  if (semTracos(pg?.parent?.database_id) !== semTracos(dbId)) throw new Error("Registro não encontrado");
  return pg;
}

export default async (req: Request, _ctx: Context) => {
  const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", ...CORS } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });
  const token = Netlify.env.get("NOTION_TOKEN");
  if (!token) return json({ error: "NOTION_TOKEN not configured" }, 500);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }
  const { action, payload, senha } = body || {};
  const p = payload || {};

  const papel: "lancar" | "config" = action === "login" ? (p.papel === "config" ? "config" : "lancar") : ACOES_CONFIG.includes(action) ? "config" : "lancar";
  if (!(await senhaOk(senha, papel))) return json({ error: "Senha incorreta ou ausente", auth: true }, 401);
  if (action === "login") return json({ ok: true });

  try {
    // ---- Horas paradas ----
    if (action === "registrar_parada") {
      if (!MAQUINAS.includes(p.maquina)) throw new Error("Selecione a máquina");
      if (!DATA.test(p.data || "")) throw new Error("Informe a data");
      if (!HHMM.test(p.horaInicio || "") || !HHMM.test(p.horaTermino || "")) throw new Error("Informe os horários de início e término");
      if (!p.motivo) throw new Error("Selecione o motivo");
      const motivos = await nomesValidos(token, "Motivo");
      if (!motivos.includes(p.motivo)) throw new Error("Motivo inválido. Atualize a página e escolha um motivo da lista");
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
          Observações: rt(String(p.obs || "").slice(0, 500)),
          "Local ID": rt(`parada-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
        },
      });
      return json({ ok: true, id: page.id, horas: horas });
    }
    if (action === "excluir_parada") {
      if (!p.id) throw new Error("id é obrigatório");
      await paginaDoBanco(token, p.id, PARADAS_DB);
      await notion(`/v1/pages/${p.id}`, "PATCH", token, { archived: true });
      return json({ ok: true });
    }

    // ---- Faltas de colaboradores ----
    if (action === "registrar_falta") {
      if (!DATA.test(p.data || "")) throw new Error("Informe a data");
      if (!TURNOS.includes(p.turno)) throw new Error("Selecione o turno");
      const funcoes = await nomesValidos(token, "Função");
      if (!funcoes.includes(p.funcao)) throw new Error("Função inválida. Atualize a página e escolha uma função da lista");
      const q = Number(p.quantidade);
      if (!Number.isInteger(q) || q < 1) throw new Error("A quantidade deve ser um número inteiro maior que zero");
      const page = await notion("/v1/pages", "POST", token, {
        parent: { type: "database_id", database_id: FALTAS_DB },
        properties: {
          "Função": title(p.funcao),
          Data: { date: { start: p.data } },
          Turno: sel(p.turno),
          Quantidade: num(q),
          Observações: rt(String(p.obs || "").slice(0, 500)),
          "Local ID": rt(`falta-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
        },
      });
      return json({ ok: true, id: page.id });
    }
    if (action === "excluir_falta") {
      if (!p.id) throw new Error("id é obrigatório");
      await paginaDoBanco(token, p.id, FALTAS_DB);
      await notion(`/v1/pages/${p.id}`, "PATCH", token, { archived: true });
      return json({ ok: true });
    }

    // ---- Configurações: lista completa de motivos ou funções ----
    // payload: { tipo: "Motivo" | "Função", itens: [{ id?, nome }] } na ordem desejada
    if (action === "salvar_config") {
      const tipo = p.tipo === "Função" ? "Função" : p.tipo === "Motivo" ? "Motivo" : null;
      if (!tipo) throw new Error("Tipo inválido");
      const itens: { id?: string; nome: string }[] = (Array.isArray(p.itens) ? p.itens : []).map((i: any) => ({ id: i.id, nome: String(i.nome || "").trim() }));
      if (itens.length === 0) throw new Error("A lista não pode ficar vazia");
      if (itens.length > 60) throw new Error("Máximo de 60 itens");
      const vistos = new Set<string>();
      for (const i of itens) {
        if (!i.nome) throw new Error("Há um item sem nome");
        if (i.nome.length > 60) throw new Error(`Nome muito longo: ${i.nome.slice(0, 20)}…`);
        const k = i.nome.toLowerCase();
        if (vistos.has(k)) throw new Error(`Item repetido: ${i.nome}`);
        vistos.add(k);
      }
      const atuais = await listaConfig(token, tipo);
      const porId = new Map(atuais.map((a) => [a.id, a]));
      const mantidos = new Set<string>();
      for (let idx = 0; idx < itens.length; idx++) {
        const it = itens[idx];
        const ex = it.id ? porId.get(it.id) : undefined;
        if (ex) {
          mantidos.add(ex.id);
          if (ex.nome !== it.nome || ex.ordem !== idx + 1) {
            await notion(`/v1/pages/${ex.id}`, "PATCH", token, { properties: { Nome: title(it.nome), Ordem: num(idx + 1) } });
          }
        } else {
          await notion("/v1/pages", "POST", token, {
            parent: { type: "database_id", database_id: CONFIG_DB },
            properties: { Nome: title(it.nome), Tipo: sel(tipo), Ordem: num(idx + 1) },
          });
        }
      }
      for (const a of atuais) {
        if (!mantidos.has(a.id)) await notion(`/v1/pages/${a.id}`, "PATCH", token, { archived: true });
      }
      return json({ ok: true });
    }

    throw new Error(`Ação desconhecida: ${action}`);
  } catch (e: any) {
    return json({ error: String((e && e.message) || e) }, 400);
  }
};

export const config: Config = { path: "/api/hp-submit" };
