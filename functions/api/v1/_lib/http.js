export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}

export function methodNotAllowed(allowed = "GET") {
  return json({ error: { code: "METHOD_NOT_ALLOWED", message: "Метод не поддерживается." } }, 405, { allow: allowed });
}

export function databaseUnavailable() {
  return json({ error: { code: "DATABASE_NOT_CONFIGURED", message: "База данных MERCY ARENA ещё не подключена." } }, 503);
}

export function parseLimit(url, fallback = 20, max = 50) {
  const value = Number(url.searchParams.get("limit"));
  return Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

export function publicList(rows, limit) {
  return { data: rows, meta: { count: rows.length, limit, has_more: rows.length === limit } };
}
