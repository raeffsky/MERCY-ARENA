import { json, databaseUnavailable, methodNotAllowed } from "../_lib/http.js";
import { advanceWinner } from "../_lib/match-progression.js";

function toHex(bytes) {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmac(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}
async function digest(value) {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return databaseUnavailable();
  const secret = String(env.MATCH_RESULTS_WEBHOOK_SECRET || "");
  if (secret.length < 32) return json({ error: { code: "WEBHOOK_NOT_CONFIGURED", message: "Webhook результатов ещё не настроен." } }, 503);
  const timestamp = String(request.headers.get("x-mercy-timestamp") || "");
  const signature = String(request.headers.get("x-mercy-signature") || "").toLowerCase();
  const seconds = Number(timestamp);
  if (!/^\\d{10}$/.test(timestamp) || !Number.isSafeInteger(seconds) || Math.abs(Math.floor(Date.now() / 1000) - seconds) > 300) {
    return json({ error: { code: "INVALID_WEBHOOK_TIMESTAMP", message: "Время webhook недействительно." } }, 401);
  }
  const raw = await request.text();
  const expected = await hmac(secret, timestamp + "." + raw);
  if (!/^[a-f0-9]{64}$/.test(signature) || !safeEqual(expected, signature)) {
    return json({ error: { code: "INVALID_WEBHOOK_SIGNATURE", message: "Подпись webhook не прошла проверку." } }, 401);
  }
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: { code: "INVALID_JSON", message: "Некорректный JSON события." } }, 400); }
  const provider = String(body.provider || "").trim().slice(0, 40);
  const eventId = String(body.event_id || "").trim().slice(0, 160);
  const matchId = Number(body.match_id), teamA = Number(body.team_a_id), teamB = Number(body.team_b_id);
  const scoreA = Number(body.score_a), scoreB = Number(body.score_b);
  if (!provider || !eventId || ![matchId, teamA, teamB, scoreA, scoreB].every(Number.isSafeInteger) || matchId < 1 || teamA < 1 || teamB < 1 || teamA === teamB || scoreA < 0 || scoreB < 0 || scoreA === scoreB) {
    return json({ error: { code: "INVALID_RESULT_EVENT", message: "В событии не хватает корректных данных матча и счёта." } }, 400);
  }
  const match = await env.DB.prepare("SELECT id,tournament_id,team_a_id,team_b_id,status FROM matches WHERE id=? LIMIT 1").bind(matchId).first();
  if (!match) return json({ error: { code: "MATCH_NOT_FOUND", message: "Матч не найден." } }, 404);
  if (String(match.team_a_id) !== String(teamA) || String(match.team_b_id) !== String(teamB)) {
    return json({ error: { code: "MATCH_TEAMS_MISMATCH", message: "Команды события не совпадают с командами матча." } }, 409);
  }
  const payloadHash = await digest(raw);
  const duplicate = await env.DB.prepare("SELECT id,match_id,validation_status FROM result_events WHERE provider=? AND provider_event_id=?").bind(provider, eventId).first();
  if (duplicate) {
    if (String(duplicate.match_id) !== String(matchId)) return json({ error: { code: "EVENT_ID_CONFLICT", message: "Этот ID события уже использован для другого матча." } }, 409);
    let progression = null;
    if (duplicate.validation_status === "valid" && match.status === "completed") {
      try { progression = await advanceWinner(env.DB, matchId, scoreA > scoreB ? teamA : teamB); }
      catch (error) { console.error("Duplicate result progression retry failed:", error); return json({ error: { code: "PROGRESSION_RETRY_FAILED", message: "Результат сохранён, но продвижение команды по сетке пока не завершено." } }, 503); }
    }
    return json({ data: { accepted: true, duplicate: true, match_id: matchId, status: duplicate.validation_status, progression } });
  }
  const collision = await env.DB.prepare("SELECT id FROM result_events WHERE provider=? AND payload_hash=?").bind(provider, payloadHash).first();
  if (collision) return json({ error: { code: "DUPLICATE_RESULT", message: "Такой результат уже поступал." } }, 409);
  if (match.status === "completed") return json({ error: { code: "MATCH_ALREADY_COMPLETED", message: "Матч уже завершён. Повторный результат требует ручной проверки." } }, 409);
  const winner = scoreA > scoreB ? teamA : teamB;
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO result_events (id,provider,provider_event_id,match_id,payload_hash,raw_payload,validation_status,received_at,reviewed_at) VALUES (?,?,?,?,?,?,'valid',?,?)").bind(crypto.randomUUID(), provider, eventId, matchId, payloadHash, raw.slice(0, 20000), now, now),
      env.DB.prepare("UPDATE matches SET score_a=?,score_b=?,winner_team_id=?,status='completed',result_source=?,result_verified_at=?,updated_at=? WHERE id=? AND status!='completed'").bind(scoreA, scoreB, winner, "webhook:" + provider, now, now, matchId),
      env.DB.prepare("INSERT INTO audit_events (actor_id,action,entity_type,entity_id,after_json) VALUES (NULL,'match_result_auto_verified','match',?,?)").bind(matchId, JSON.stringify({ provider, event_id: eventId, score_a: scoreA, score_b: scoreB, winner_team_id: winner }))
    ]);
    const progression = await advanceWinner(env.DB, matchId, winner);
    return json({ data: { accepted: true, duplicate: false, match_id: matchId, status: "completed", score_a: scoreA, score_b: scoreB, winner_team_id: winner, progression } }, 201);
  } catch (error) {
    console.error("MERCY result webhook failed:", error);
    return json({ error: { code: "RESULT_INGEST_FAILED", message: "Не удалось сохранить результат матча." } }, 500);
  }
}
export function onRequestGet() { return methodNotAllowed("POST"); }
