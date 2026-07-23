import type { Context, Config } from "@netlify/functions";

// CORS is required here on purpose: this endpoint is polled by a public,
// static status page (a different origin during local preview) and must be
// reachable from any device's browser.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const NOTION_VERSION = "2022-06-28";
// NOTE: these must be the *database* IDs (from the app.notion.com/p/... URL),
// not the data-source/collection IDs — the legacy /v1/databases/{id}/query
// endpoint (Notion-Version 2022-06-28) only accepts the former.
const ORDERS_DS = "34adda41-950c-4d6d-8d2e-a200c9e9a896";
const PARADAS_DS = "66ed6629-11b0-4326-bbab-f8eb448fadb8";

function getText(prop: any): string {
  if (!prop) return "";
  const arr = prop.title || prop.rich_text || [];
  return arr.map((t: any) => t.plain_text).join("");
}
function getNumber(prop: any): number | null {
  return prop && typeof prop.number === "number" ? prop.number : null;
}
function getSelect(prop: any): string | null {
  return prop && prop.select ? prop.select.name : null;
}
function getCheckbox(prop: any): boolean {
  return !!(prop && prop.checkbox);
}
function getDate(prop: any): string | null {
  return prop && prop.date ? prop.date.start : null;
}

// Notion stores plain "HH:MM" text; convert to a same-day timestamp so the
// public page can reuse the same diffHoras/hhmm helpers as the main panel.
function toTsFromDateAndTime(dateStr: string | null, timeStr: string): number | null {
  if (!dateStr || !timeStr) return null;
  const d = new Date(`${dateStr}T${timeStr}:00`);
  const t = d.getTime();
  return isNaN(t) ? null : t;
}

async function queryDataSource(dsId: string, token: string) {
  const results: any[] = [];
  let cursor: string | undefined;
  do {
    const res = await fetch(`https://api.notion.com/v1/databases/${dsId}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ page_size: 100, start_cursor: cursor }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Notion query failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    results.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return results;
}

function mapOrder(page: any) {
  const p = page.properties || {};
  const data = getDate(p["Data"]);
  const horaInicio = getText(p["Hora Início"]);
  const horaTermino = getText(p["Hora Término"]);
  return {
    id: getText(p["Local ID"]) || page.id,
    data,
    turno: getSelect(p["Turno"]),
    maquina: getSelect(p["Máquina"]),
    opNumero: getText(p["Nº OP"]),
    produto: getText(p["Produto"]),
    qtdPlanejada: getNumber(p["Qtd Planejada"]),
    qtdReal: getNumber(p["Qtd Real"]),
    horaInicioTs: toTsFromDateAndTime(data, horaInicio),
    horaTerminoTs: horaTermino ? toTsFromDateAndTime(data, horaTermino) : null,
    tempoNecessario: getNumber(p["Tempo Necessário"]),
    tempoReal: getNumber(p["Tempo Real"]),
    refugo: getCheckbox(p["Refugo"]),
    qtdRefugo: getNumber(p["Qtd Refugo"]),
    bags: getCheckbox(p["Bags"]),
    qtdBags: getNumber(p["Qtd Bags"]),
    status: getSelect(p["Status"]),
    obs: getText(p["Observações"]),
    ts: new Date(page.created_time).getTime(),
  };
}

function mapParada(page: any) {
  const p = page.properties || {};
  const data = getDate(p["Data"]);
  const horaInicio = getText(p["Hora Início"]);
  const horaTermino = getText(p["Hora Término"]);
  return {
    id: getText(p["Local ID"]) || page.id,
    data,
    turno: getSelect(p["Turno"]),
    maquina: getText(p["Máquina"]),
    motivo: getSelect(p["Motivo"]),
    horaInicioTs: toTsFromDateAndTime(data, horaInicio),
    horaTerminoTs: horaTermino ? toTsFromDateAndTime(data, horaTermino) : null,
    horasParadas: getNumber(p["Horas Paradas"]),
    status: getSelect(p["Status"]),
    obs: getText(p["Observações"]),
    ts: new Date(page.created_time).getTime(),
  };
}

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "GET") {
    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }

  const token = Netlify.env.get("NOTION_TOKEN");
  if (!token) {
    return new Response(JSON.stringify({ error: "NOTION_TOKEN not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  try {
    const [orderPages, paradaPages] = await Promise.all([
      queryDataSource(ORDERS_DS, token),
      queryDataSource(PARADAS_DS, token),
    ]);
    const ordens = orderPages.map(mapOrder);
    const paradas = paradaPages.map(mapParada);
    return new Response(JSON.stringify({ ordens, paradas, updatedAt: Date.now() }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: String(e && e.message || e) }), {
      status: 502,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
};

export const config: Config = {
  path: "/api/data",
};
