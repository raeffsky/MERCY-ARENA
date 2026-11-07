const encoder = new TextEncoder();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function validId(value, maxLength = 128) {
  return (typeof value === "string" || typeof value === "number") &&
    String(value).trim().length > 0 && String(value).trim().length <= maxLength;
}

function validScore(value) {
  return (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === "string" && /^\d+$/.test(value.trim()) && Number.isSafeInteger(Number(value)));
}

async function sign(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("");
}

function destinationUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    return new URL("/api/v1/webhooks/results", url.origin).toString();
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/provider/results") return json({ error: "Not found" }, 404);
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const sourceToken = String(env.SOURCE_WEBHOOK_TOKEN || "");
    const mercySecret = String(env.MATCH_RESULTS_WEBHOOK_SECRET || "");
    const destination = destinationUrl(String(env.MERCY_ARENA_URL || ""));
    if (sourceToken.length < 24 || mercySecret.length < 32 || !destination) {
      return json({ error: "Results relay is not configured" }, 503);
    }
    const authorization = String(request.headers.get("authorization") || "");
    if (!safeEqual(authorization, "Bearer " + sourceToken)) {
      return json({ error: "Unauthorized provider request" }, 401);
    }

    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (declaredLength > 32768) return json({ error: "Payload exceeds 32 KB" }, 413);
    const raw = await request.text();
    if (encoder.encode(raw).byteLength > 32768) return json({ error: "Payload exceeds 32 KB" }, 413);

    let body;
    try { body = JSON.parse(raw); } catch { return json({ error: "Invalid JSON" }, 400); }
    const provider = String(body.provider || "").trim();
    const eventId = String(body.event_id || "").trim();
    const teamA = String(body.team_a_id ?? "").trim();
    const teamB = String(body.team_b_id ?? "").trim();
    if (!/^[a-zA-Z0-9._-]{1,40}$/.test(provider) ||
        !validId(body.event_id, 160) || !validId(body.match_id) ||
        !validId(body.team_a_id) || !validId(body.team_b_id) || teamA === teamB ||
        !validScore(body.score_a) || !validScore(body.score_b) ||
        Number(body.score_a) === Number(body.score_b)) {
      return json({ error: "Invalid normalized match result" }, 400);
    }
    if (!eventId) return json({ error: "Missing provider event ID" }, 400);

    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await sign(mercySecret, timestamp + "." + raw);
    let upstream;
    try {
      upstream = await fetch(destination, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "x-mercy-timestamp": timestamp,
          "x-mercy-signature": signature
        },
        body: raw
      });
    } catch {
      return json({ error: "MERCY ARENA webhook is unreachable" }, 502);
    }
    const responseText = await upstream.text();
    let responseBody;
    try { responseBody = JSON.parse(responseText); } catch { responseBody = { message: responseText.slice(0, 1000) }; }
    return json({ forwarded: upstream.ok, status: upstream.status, response: responseBody }, upstream.ok ? 200 : 502);
  }
};
