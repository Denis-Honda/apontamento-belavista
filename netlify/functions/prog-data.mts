import type { Context, Config } from "@netlify/functions";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const NOTION_VERSION = "2022-06-28";
const PROG_DB = "df4e3905-2eef-48ec-93ac-be17ff30fdc4";
const PARADAS_DB = "66ed6629-11b0-4326-bbab-f8eb448fadb8";

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
    if (!res.ok) throw new Error(`Notion query failed (${res.status}): ${await res.text()}`);
    const d = await res.json();
    out.push(...(d.results || []));
    cursor = d.has_more ? d.next_cursor : undefined;
  } while (cursor);
  return out;
}

function mapProg(pg: any) {
  const p = pg.properties || {};
  return {
    id: pg.id,
    maquina: txt(p["Máquina"]),
    data: dt(p["Data"]),
    produto: txt(p["Produto"]),
    qtdProgramada: num(p["Qtd a Produzir"]),
    inicioPrevisto: txt(p["Início Previsto"]),
    terminoPrevisto: txt(p["Término Previsto"]),
    secagemMin: num(p["Secagem (min)"]),
    turno: sel(p["Turno"]),
    status: sel(p["Status"]) || "Não iniciado",
    opNumero: txt(p["Nº OP"]),
    qtdProduzida: num(p["Qtd Produzida"]),
    inicioReal: txt(p["Início Real"]),
    terminoReal: txt(p["Término Real"]),
  };
}
function mapParada(pg: any) {
  const p = pg.properties || {};
  return {
    id: pg.id,
    maquina: txt(p["Máquina"]),
    data: dt(p["Data"]),
    motivo: sel(p["Motivo"]),
    horaInicio: txt(p["Hora Início"]),
    horaTermino: txt(p["Hora Término"]),
    horasParadas: num(p["Horas Paradas"]),
    obs: txt(p["Observações"]),
  };
}

export default async (req: Request, _ctx: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const token = Netlify.env.get("NOTION_TOKEN");
  if (!token) return new Response(JSON.stringify({ error: "NOTION_TOKEN not configured" }), { status: 500, headers: { "Content-Type": "application/json", ...CORS } });
  try {
    const [prog, par] = await Promise.all([queryAll(PROG_DB, token), queryAll(PARADAS_DB, token)]);
    return new Response(JSON.stringify({ programacao: prog.map(mapProg), paradas: par.map(mapParada), updatedAt: Date.now() }), {
      status: 200, headers: { "Content-Type": "application/json", ...CORS },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: String((e && e.message) || e) }), { status: 502, headers: { "Content-Type": "application/json", ...CORS } });
  }
};

export const config: Config = { path: "/api/prog-data" };
