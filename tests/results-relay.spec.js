const { test, expect } = require("@playwright/test");

let relay;
test.beforeAll(async () => {
  relay = (await import("../integrations/results-relay/worker.mjs")).default;
});

test("provider-neutral relay authenticates the source and forwards an HMAC-signed result", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ data: { accepted: true, status: "completed" } }), { status: 201 });
  };
  try {
    const raw = JSON.stringify({
      provider: "test-provider",
      event_id: "event-001",
      match_id: 501,
      team_a_id: 11,
      team_b_id: 12,
      score_a: 2,
      score_b: 1
    });
    const response = await relay.fetch(new Request("https://relay.example/provider/results", {
      method: "POST",
      headers: { authorization: "Bearer source-token-with-at-least-24-chars" },
      body: raw
    }), {
      SOURCE_WEBHOOK_TOKEN: "source-token-with-at-least-24-chars",
      MATCH_RESULTS_WEBHOOK_SECRET: "mercy-shared-secret-with-at-least-32-characters",
      MERCY_ARENA_URL: "https://mercy-arena.pages.dev"
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.forwarded).toBeTruthy();
    expect(body.status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://mercy-arena.pages.dev/api/v1/webhooks/results");
    expect(calls[0].init.body).toBe(raw);
    expect(calls[0].init.headers["x-mercy-signature"]).toMatch(/^[a-f0-9]{64}$/);
    expect(calls[0].init.headers["x-mercy-timestamp"]).toMatch(/^\d{10}$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider-neutral relay rejects requests without the configured source token", async () => {
  const response = await relay.fetch(new Request("https://relay.example/provider/results", {
    method: "POST",
    body: "{}"
  }), {
    SOURCE_WEBHOOK_TOKEN: "source-token-with-at-least-24-chars",
    MATCH_RESULTS_WEBHOOK_SECRET: "mercy-shared-secret-with-at-least-32-characters",
    MERCY_ARENA_URL: "https://mercy-arena.pages.dev"
  });
  expect(response.status).toBe(401);
});
