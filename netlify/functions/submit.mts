import type { Context, Config } from "@netlify/functions";

// Public write endpoint used by /lancar.html so operators can launch and
// close orders/paradas from any device without opening Notion or the
// Cowork panel. Mirrors the same two databases used by /api/data.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const NOTION_VERSION = "2022-06-28";
const ORDERS_DB = "34adda41-950c-4d6d-8d2e-a200c9e9a896";
const PARADAS_DB = "66ed6629-11b0-4326-bbab-f8eb448fadb8";
const METAS_DB = "6fea4c44-24e9-4006-a74e-071bcf4a06cd";

function rt(text: string) {
  return { rich_text: [{ text: { content: String(text ?? "") } }] };
}
function title(text: string) {
  return { title: [{ text: { content: String(text ?? "") } }] };
}
function sel(name: string | null | undefined) {
  return name ? { select: { name } } : { select: null };
}
function num(n: any) {
  const v = n === "" || n === null || n === undefined ? null : Number(n);
  return { number: v === null || isNaN(v) ? null : v };
}
function chk(b: any) {
  return { checkbox: !!b };
}

function newLocalId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// Diferença em horas entre dois horários "HH:MM", assumindo que Término
// pode cair no dia seguinte (turno da noite) — mesma regra do painel principal.
function diffHorasHHMM(iniStr: string, fimStr: string): number | null {
  if (!iniStr || !fimStr) return null;
  const [ih, im] = iniStr.split(":").map(Number);
  const [fh, fm] = fimStr.split(":").map(Number);
  if ([ih, im, fh, fm].some((n) => isNaN(n))) return null;
  let diff = (fh * 60 + fm) - (ih * 60 + im);
  if (diff < 0) diff += 24 * 60;
  return diff / 60;
}

async function notionRequest(path: string, method: string, token: string, body: any) {
  const res = await fetch(`https://api.notion.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Notion ${method} ${path} failed (${res.status}): ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

// Usado apenas para o upsert de Metas (poucos registros — uma consulta cheia
// é suficiente, sem precisar de filtro server-side).
async function queryAllPages(dbId: string, token: string) {
  const results: any[] = [];
  let cursor: string | undefined;
  do {
    const data = await notionRequest(`/v1/databases/${dbId}/query`, "POST", token, {
      page_size: 100,
      start_cursor: cursor,
    });
    results.push(...((data && data.results) || []));
    cursor = data && data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return results;
}

function getPlainText(prop: any): string {
  if (!prop) return "";
  const arr = prop.title || prop.rich_text || [];
  return arr.map((t: any) => t.plain_text).join("");
}
function getPlainDate(prop: any): string | null {
  return prop && prop.date ? prop.date.start : null;
}

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }

  const token = Netlify.env.get("NOTION_TOKEN");
  if (!token) {
    return new Response(JSON.stringify({ error: "NOTION_TOKEN not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "JSON inválido" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  const { action, payload } = body || {};

  try {
    if (action === "iniciar_ordem") {
      const p = payload || {};
      if (!p.opNumero || !p.maquina || !p.turno) {
        throw new Error("Campos obrigatórios: Nº OP, Máquina e Turno");
      }
      const localId = newLocalId("op");
      const properties: any = {
        "Nº OP": title(p.opNumero),
        Data: { date: { start: p.data || new Date().toISOString().slice(0, 10) } },
        Turno: sel(p.turno),
        Máquina: sel(p.maquina),
        Produto: rt(p.produto || ""),
        "Qtd Planejada": num(p.qtdPlanejada),
        "Tempo Necessário": num(p.tempoNecessario),
        "Hora Início": rt(p.horaInicio || ""),
        Status: sel("Em Produção"),
        Observações: rt(p.obs || ""),
        "Local ID": rt(localId),
      };
      const page = await notionRequest("/v1/pages", "POST", token, {
        parent: { type: "database_id", database_id: ORDERS_DB },
        properties,
      });
      return ok({ notionId: page.id, localId });
    }

    if (action === "finalizar_ordem") {
      const p = payload || {};
      if (!p.notionId) throw new Error("notionId da ordem é obrigatório");
      const properties: any = {
        "Hora Término": rt(p.horaTermino || ""),
        "Qtd Real": num(p.qtdReal),
        "Tempo Real": num(p.tempoReal),
        Refugo: chk(p.refugo),
        "Qtd Refugo": num(p.refugo ? p.qtdRefugo : null),
        Bags: chk(p.bags),
        "Qtd Bags": num(p.bags ? p.qtdBags : null),
        Status: sel("Finalizada"),
      };
      if (p.obs !== undefined) properties["Observações"] = rt(p.obs || "");
      await notionRequest(`/v1/pages/${p.notionId}`, "PATCH", token, { properties });
      return ok({ notionId: p.notionId });
    }

    // Correção pós-lançamento: permite ajustar horas e quantidades de uma
    // ordem já lançada (em produção ou já finalizada), sem depender do status.
    if (action === "editar_ordem") {
      const p = payload || {};
      if (!p.notionId) throw new Error("notionId da ordem é obrigatório");
      const tempoReal = diffHorasHHMM(p.horaInicio, p.horaTermino);
      const properties: any = {};
      if (p.horaInicio !== undefined) properties["Hora Início"] = rt(p.horaInicio || "");
      if (p.horaTermino !== undefined) properties["Hora Término"] = rt(p.horaTermino || "");
      if (p.qtdPlanejada !== undefined) properties["Qtd Planejada"] = num(p.qtdPlanejada);
      if (p.qtdReal !== undefined) properties["Qtd Real"] = num(p.qtdReal);
      if (p.horaTermino) properties["Tempo Real"] = num(tempoReal);
      if (p.refugo !== undefined) {
        properties["Refugo"] = chk(p.refugo);
        properties["Qtd Refugo"] = num(p.refugo ? p.qtdRefugo : null);
      }
      if (p.bags !== undefined) {
        properties["Bags"] = chk(p.bags);
        properties["Qtd Bags"] = num(p.bags ? p.qtdBags : null);
      }
      if (p.obs !== undefined) properties["Observações"] = rt(p.obs || "");
      await notionRequest(`/v1/pages/${p.notionId}`, "PATCH", token, { properties });
      return ok({ notionId: p.notionId });
    }

    if (action === "editar_parada") {
      const p = payload || {};
      if (!p.notionId) throw new Error("notionId da parada é obrigatório");
      const horasCalc = diffHorasHHMM(p.horaInicio, p.horaTermino);
      const properties: any = {};
      if (p.horaInicio !== undefined) properties["Hora Início"] = rt(p.horaInicio || "");
      if (p.horaTermino !== undefined) properties["Hora Término"] = rt(p.horaTermino || "");
      if (p.horaTermino) {
        properties["Horas Paradas"] = num(horasCalc);
      } else if (p.horasParadas !== undefined) {
        properties["Horas Paradas"] = num(p.horasParadas);
      }
      if (p.qtdFuncionariosFaltantes !== undefined) {
        properties["Qtd Funcionários Faltantes"] = num(p.qtdFuncionariosFaltantes);
      }
      if (p.obs !== undefined) properties["Observações"] = rt(p.obs || "");
      await notionRequest(`/v1/pages/${p.notionId}`, "PATCH", token, { properties });
      return ok({ notionId: p.notionId });
    }

    if (action === "iniciar_parada") {
      const p = payload || {};
      if (!p.maquina || !p.turno || !p.motivo) {
        throw new Error("Campos obrigatórios: Máquina, Turno e Motivo");
      }
      const localId = newLocalId("parada");
      const properties: any = {
        Máquina: title(p.maquina),
        Data: { date: { start: p.data || new Date().toISOString().slice(0, 10) } },
        Turno: sel(p.turno),
        Motivo: sel(p.motivo),
        "Hora Início": rt(p.horaInicio || ""),
        Status: sel("Em Aberto"),
        Observações: rt(p.obs || ""),
        "Local ID": rt(localId),
      };
      if (p.motivo === "Falta de funcionário" && p.qtdFuncionariosFaltantes !== undefined) {
        properties["Qtd Funcionários Faltantes"] = num(p.qtdFuncionariosFaltantes);
      }
      const page = await notionRequest("/v1/pages", "POST", token, {
        parent: { type: "database_id", database_id: PARADAS_DB },
        properties,
      });
      return ok({ notionId: page.id, localId });
    }

    // Metas de produção por turno: upsert (uma linha por data+turno) já que
    // o operador reenvia os 3 valores toda vez que ajusta a meta do dia.
    if (action === "salvar_metas") {
      const p = payload || {};
      const data = p.data || new Date().toISOString().slice(0, 10);
      const metas: Record<string, any> = p.metas || {};
      const existentes = await queryAllPages(METAS_DB, token);
      const saved: any[] = [];
      for (const turno of Object.keys(metas)) {
        const valor = metas[turno];
        if (valor === "" || valor === null || valor === undefined) continue;
        const match = existentes.find((pg: any) => {
          const props = pg.properties || {};
          return getPlainDate(props["Data"]) === data && getPlainText(props["Turno"]) === turno;
        });
        const properties: any = {
          Turno: title(turno),
          Data: { date: { start: data } },
          Meta: num(valor),
        };
        if (match) {
          await notionRequest(`/v1/pages/${match.id}`, "PATCH", token, { properties });
          saved.push({ turno, notionId: match.id });
        } else {
          properties["Local ID"] = rt(newLocalId("meta"));
          const page = await notionRequest("/v1/pages", "POST", token, {
            parent: { type: "database_id", database_id: METAS_DB },
            properties,
          });
          saved.push({ turno, notionId: page.id });
        }
      }
      return ok({ saved });
    }

    if (action === "encerrar_parada") {
      const p = payload || {};
      if (!p.notionId) throw new Error("notionId da parada é obrigatório");
      const properties: any = {
        "Hora Término": rt(p.horaTermino || ""),
        "Horas Paradas": num(p.horasParadas),
        Status: sel("Encerrada"),
      };
      if (p.obs !== undefined) properties["Observações"] = rt(p.obs || "");
      await notionRequest(`/v1/pages/${p.notionId}`, "PATCH", token, { properties });
      return ok({ notionId: p.notionId });
    }

    throw new Error(`Ação desconhecida: ${action}`);
  } catch (e: any) {
    return new Response(JSON.stringify({ error: String((e && e.message) || e) }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  function ok(data: any) {
    return new Response(JSON.stringify({ ok: true, ...data }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
};

export const config: Config = {
  path: "/api/submit",
};
