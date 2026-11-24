import type { Context, Config } from "@netlify/functions";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const NOTION_VERSION = "2022-06-28";
const PARADAS_DB = "66ed6629-11b0-4326-bbab-f8eb448fadb8";
const FALTAS_DB = "ca7bd838-5ee7-4b4f-ac0a-92a045d62416";
const CONFIG_DB = "422ad3bc-da5e-81bf-aef3-f8c686add659";

const MOTIVOS_PADRAO = ["Falta de energia", "Falta de funcionário", "Falta de Matéria-prima", "Falta de Mecânico", "Falta de Embalagem", "Limpeza", "Manutenção", "Máquina quebrada", "Reunião", "Saída Médico / Particular", "Sem demanda", "Trator quebrado", "Treinamento"];
const FUNCOES_PADRAO = ["Envasador(a)", "Operador(a) de Máquina", "Operador(a) de Trator", "Operador(a) Empilhadeira", "Etiquetador(a)", "Preparador(a) de Aditivos"];

const txt = (p: any) => ((p && (p.title || p.rich_text)) || []).map((t: any) => t.plain_text).join("");
const num = (p: any) => (p && typeof p.number === "number" ? p.number : null);
const sel = (p: any) => (p && p.select ? p.select.name : null);
const dt = (p: any) => (p && p.date ? p.date.start : null);

async function queryAll(dbId: string, token: string) {
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
      body: JSON.stringify({ page_size: 100, start_cursor: cursor }),
    });
    if (!res.ok) throw new Error(`Notion query failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const d = await res.json();
    out.push(...(d.results || []));
    cursor = d.has_more ? d.next_cursor : undefined;
  } while (cursor);
  return out;
}

export default async (req: Request, _ctx: Context) => {
  const H = { "Content-Type": "application/json", ...CORS };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const token = Netlify.env.get("NOTION_TOKEN");
  if (!token) return new Response(JSON.stringify({ error: "NOTION_TOKEN not configured" }), { status: 500, headers: H });
  try {
    const par = await queryAll(PARADAS_DB, token);
    const paradas = par
      .map((pg: any) => {
        const p = pg.properties || {};
        return {
          id: pg.id,
          maquina: txt(p["Máquina"]),
          data: dt(p["Data"]),
          turno: sel(p["Turno"]),
          motivo: sel(p["Motivo"]),
          horaInicio: txt(p["Hora Início"]),
          horaTermino: txt(p["Hora Término"]),
          horasParadas: num(p["Horas Paradas"]),
          obs: txt(p["Observações"]),
        };
      })
      .filter((x: any) => x.horasParadas != null); // ignora registros antigos ainda "em aberto"

    let faltas: any[] = [];
    let faltasErro: string | null = null;
    try {
      faltas = (await queryAll(FALTAS_DB, token)).map((pg: any) => {
        const p = pg.properties || {};
        return { id: pg.id, funcao: txt(p["Função"]), data: dt(p["Data"]), turno: sel(p["Turno"]), quantidade: num(p["Quantidade"]), obs: txt(p["Observações"]) };
      });
    } catch (e: any) {
      faltasErro = String((e && e.message) || e).slice(0, 200);
    }

    let motivos = MOTIVOS_PADRAO.slice();
    let funcoes = FUNCOES_PADRAO.slice();
    let config: any[] = [];
    let configErro: string | null = null;
    let configPadrao = true;
    try {
      const rows = (await queryAll(CONFIG_DB, token)).map((pg: any) => {
        const p = pg.properties || {};
        return { id: pg.id, tipo: sel(p["Tipo"]), nome: txt(p["Nome"]), ordem: num(p["Ordem"]) ?? 9999 };
      });
      config = rows;
      const m = rows.filter((r) => r.tipo === "Motivo").sort((a, b) => a.ordem - b.ordem).map((r) => r.nome);
      const f = rows.filter((r) => r.tipo === "Função").sort((a, b) => a.ordem - b.ordem).map((r) => r.nome);
      if (m.length) { motivos = m; configPadrao = false; }
      if (f.length) { funcoes = f; configPadrao = false; }
    } catch (e: any) {
      configErro = String((e && e.message) || e).slice(0, 200);
    }

    return new Response(JSON.stringify({ paradas, faltas, faltasErro, motivos, funcoes, config, configErro, configPadrao, updatedAt: Date.now() }), { status: 200, headers: H });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: String((e && e.message) || e) }), { status: 502, headers: H });
  }
};

export const config: Config = { path: "/api/hp-data" };
