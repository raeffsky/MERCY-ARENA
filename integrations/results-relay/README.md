# MERCY ARENA Results Relay

The relay is a provider-neutral Cloudflare Worker. It accepts a normalized match result from an upstream provider, authenticates that provider with a bearer token, validates the event, signs the unchanged request body with the MERCY ARENA webhook secret, and forwards it to the Pages API.

It does **not** scrape MLBB, connect to a game client, or obtain results by itself. A real provider or trusted result collector must send the normalized event.

## Endpoint

`POST /provider/results`

Required JSON:

```json
{
  "provider": "provider-name",
  "event_id": "provider-event-unique-id",
  "match_id": "MERCY-ARENA-match-id",
  "team_a_id": "MERCY-ARENA-team-a-id",
  "team_b_id": "MERCY-ARENA-team-b-id",
  "score_a": 2,
  "score_b": 1
}
```

Scores must be non-negative integers and cannot be tied. Team IDs and match ID must refer to the exact MERCY ARENA fixture. The downstream webhook performs the authoritative fixture/team, timestamp, signature, duplicate-event, and progression checks.

The provider sends:

```http
Authorization: Bearer <SOURCE_WEBHOOK_TOKEN>
Content-Type: application/json
```

The relay forwards the exact raw JSON body and adds:

- `x-mercy-timestamp`: Unix timestamp in seconds
- `x-mercy-signature`: lowercase hex HMAC-SHA256 of `timestamp + "." + raw_body`

## Deploy

From the repository root, install Wrangler if it is not already available in the deployment environment:

```bash
npm install --save-dev wrangler
npx wrangler@latest deploy --config integrations/results-relay/wrangler.toml
```

Configure secrets without committing them:

```bash
npx wrangler@latest secret put SOURCE_WEBHOOK_TOKEN --config integrations/results-relay/wrangler.toml
npx wrangler@latest secret put MATCH_RESULTS_WEBHOOK_SECRET --config integrations/results-relay/wrangler.toml
```

The production origin `https://mercy-arena.pages.dev` is set as a non-secret variable in `wrangler.toml`. Change that value before deployment if the Pages production domain changes. The relay deliberately rejects URLs with credentials, a custom path, query, fragment, or non-HTTPS protocol.

The `MATCH_RESULTS_WEBHOOK_SECRET` value must be identical to the Cloudflare Pages secret with the same name. Use a separately generated high-entropy `SOURCE_WEBHOOK_TOKEN` and share it only with the selected provider/collector.

## Smoke test

After deployment, send a known test fixture with a provider event ID that has never been used:

```bash
curl -i https://<your-worker-hostname>/provider/results \
  -H "Authorization: Bearer $SOURCE_WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @sample-result.json
```

Do not test against a real match unless the result is verified and the organizer explicitly intends to complete that fixture. The MERCY ARENA webhook advances the bracket when it accepts a valid result.

The relay returns the downstream HTTP status. A downstream 4xx is a rejected event, not a transient network failure; a network failure returns 502.

## Security and limits

- HTTPS destination only; redirects are disabled.
- Source bearer token is compared without an early-exit string comparison.
- HMAC secret and source token are Worker secrets, never frontend variables.
- Payload limit: 32 KB.
- Provider event IDs are required; deduplication is enforced by the MERCY ARENA API.
- No result is trusted merely because it came through this relay. The provider/collector remains a separate trust boundary.

## Tests

The repository Playwright suite includes relay tests for route/method handling, missing configuration, provider authentication, invalid scores, exact-body forwarding, HMAC verification, upstream error propagation, and network failure.
