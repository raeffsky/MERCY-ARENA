import { json } from "./_lib/http.js";

export function onRequestGet({ env }) {
  return json({
    service: "MERCY ARENA API",
    version: "v1",
    status: env.DB ? "ready" : "database_not_configured",
    database: env.DB ? "connected" : "not_connected"
  }, env.DB ? 200 : 503);
}
