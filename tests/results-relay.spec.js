const { test, expect } = require("@playwright/test");
const { webcrypto } = require("node:crypto");

globalThis.crypto ||= webcrypto;

let worker;
test.beforeAll(async () => {
  ({ default: worker } = await import("../integrations/results-relay/worker.mjs"));
});

const config = {
  SOURCE_WEBHOOK_TOKEN: "source-token-with-at-least-24-characters",
  MATCH_RESULTS_WEBHOOK_SECRET: "mercy-webhook-secret-with-at-least-32-characters",
  MERCY_ARENA_URL: "https://mercy-arena.pages.dev"
};
const event = {
  provider: "mlbb-provider", event_id: "event-001", match_id: "match-123",
  team_a_id: "team-a", team_b_id: "team-b", score_a: 2, score_b: 1
};

function request(body = event, headers = {}) {
  return new Request("https://relay.example/provider/results", {
    method: "POST",
    headers: { authorization: "Bearer " + config.SOURCE_WEBHOOK_TOKEN, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

async function signature(secret, timestamp, raw) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(timestamp + "." + raw));
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, "0")).join("");
}

test.describe("MERCY ARENA results relay", () => {
  let originalFetch;
  test.beforeEach(() => { originalFetch = globalThis.fetch; });
  test.afterEach(() => { globalThis.fetch = originalFetch; });

  test("rejects unknown routes and unsupported methods", async () => {
    expect((await worker.fetch(new Request("https://relay.example/"), config)).status).toBe(404);
    expect((await worker.fetch(new Request("https://relay.example/provider/results"), config)).status).toBe(405);
  });

  test("fails closed when secrets or the destination are not configured", async () => {
    expect((await worker.fetch(request(), { ...config, SOURCE_WEBHOOK_TOKEN: "" })).status).toBe(503);
    expect((await worker.fetch(request(), { ...config, MERCY_ARENA_URL: "http://localhost:8788" })).status).toBe(503);
  });

  test("rejects unauthorized providers before contacting MERCY ARENA", async () => {
    globalThis.fetch = async () => { throw new Error("upstream must not be called"); };
    const response = await worker.fetch(new Request("https://relay.example/provider/results", {
      method: "POST", headers: { authorization: "Bearer wrong-token" }, body: JSON.stringify(event)
    }), config);
    expect(response.status).toBe(401);
  });

  test("rejects malformed normalized results before forwarding", async () => {
    globalThis.fetch = async () => { throw new Error("upstream must not be called"); };
    expect((await worker.fetch(request({ ...event, score_a: 1.5 }), config)).status).toBe(400);
    expect((await worker.fetch(request({ ...event, score_a: 1, score_b: 1 }), config)).status).toBe(400);
  });

  test("forwards the exact payload with a valid MERCY HMAC signature", async () => {
    let forwarded;
    globalThis.fetch = async (url, options) => {
      forwarded = { url, options };
      return new Response(JSON.stringify({ data: { accepted: true } }), { status: 200 });
    };
    const raw = JSON.stringify(event);
    const response = await worker.fetch(request(raw), config);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.forwarded).toBe(true);
    expect(forwarded.url).toBe("https://mercy-arena.pages.dev/api/v1/webhooks/results");
    expect(forwarded.options.body).toBe(raw);
    expect(forwarded.options.redirect).toBe("error");
    const timestamp = forwarded.options.headers["x-mercy-timestamp"];
    expect(forwarded.options.headers["x-mercy-signature"]).toBe(
      await signature(config.MATCH_RESULTS_WEBHOOK_SECRET, timestamp, raw)
    );
  });

  test("preserves upstream client errors instead of disguising them as relay failures", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: { code: "MATCH_ALREADY_COMPLETED" }
    }), { status: 409 });
    const response = await worker.fetch(request(), config);
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body.forwarded).toBe(false);
    expect(body.status).toBe(409);
  });

  test("returns a gateway error when MERCY ARENA cannot be reached", async () => {
    globalThis.fetch = async () => { throw new Error("network unavailable"); };
    expect((await worker.fetch(request(), config)).status).toBe(502);
  });
});
