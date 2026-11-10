# MERCY ARENA match result webhook

Endpoint: `POST /api/v1/webhooks/results`

This endpoint accepts signed match-completion events from a trusted match-data provider or a small relay service. It does not scrape MLBB or discover match results by itself. A provider/relay must send the event after the game ends.

## Cloudflare secret

Create a Pages secret named `MATCH_RESULTS_WEBHOOK_SECRET` with at least 32 random characters. Keep it only in the provider/relay and Cloudflare. Never put it in the browser.

## Request body

```json
{
  "provider": "provider-name",
  "event_id": "unique-provider-event-id",
  "match_id": 123,
  "team_a_id": 45,
  "team_b_id": 46,
  "score_a": 2,
  "score_b": 1
}
```

The match must already exist in a published or active MERCY ARENA tournament, be scheduled or in progress, and its team IDs must match the event. Cancelled, postponed, draft and already completed matches cannot accept a new result. Scores represent maps won: BO1 requires a 1-map win, BO3 requires 2, and BO5 requires 3. The series format is read from the match room configuration (BO1 by default). Ties, incomplete series, unknown matches, mismatched teams and conflicting event replays are rejected. A valid signed event is stored in `result_events`, marks the match completed, sets its winner and verification timestamp, and writes an audit event. Repeated delivery of the same provider event is idempotent and can safely retry bracket progression if the first attempt did not finish.

## Signature

Use the raw UTF-8 request body exactly as sent.

1. Set `timestamp` to the current Unix time in seconds.
2. Compute HMAC-SHA256 using `MATCH_RESULTS_WEBHOOK_SECRET` over `timestamp + "." + rawBody`.
3. Send lowercase hex digest in `x-mercy-signature`.
4. Send timestamp in `x-mercy-timestamp`.

Requests older than five minutes are rejected.

## Provider integration status

The receiving endpoint and validation contract are implemented. Automatic results become live only after a real provider or relay is configured to send signed events. The platform must not invent results or treat unverified client submissions as official.

## Provider-neutral Cloudflare relay

The repository includes a small Cloudflare Worker adapter at `integrations/results-relay/worker.mjs`. It does not scrape MLBB or invent results. It provides a secure bridge for a chosen provider that can already send a normalized result event.

Deploy it separately:

```bash
cd integrations/results-relay
npx wrangler deploy
```

Configure these Worker secrets/variables:

- `SOURCE_WEBHOOK_TOKEN`: bearer token accepted from the upstream provider or your trusted ingestion service (at least 24 characters).
- `MATCH_RESULTS_WEBHOOK_SECRET`: the same random secret configured on the MERCY ARENA Pages project (at least 32 characters).
- `MERCY_ARENA_URL`: the HTTPS origin, for example `https://mercy-arena.pages.dev`.

Set secrets with `npx wrangler secret put SOURCE_WEBHOOK_TOKEN` and `npx wrangler secret put MATCH_RESULTS_WEBHOOK_SECRET`. Set `MERCY_ARENA_URL` as a Worker variable. Keep both secrets out of source control and browser code.

The upstream provider posts the normalized JSON body from this document to `POST /provider/results` and authenticates with `Authorization: Bearer <SOURCE_WEBHOOK_TOKEN>`. The relay validates the payload, signs the exact raw body using the shared MERCY secret, and forwards it to `/api/v1/webhooks/results`. It rejects unknown paths, non-POST requests, oversized bodies, invalid scores, duplicate team IDs, and unauthenticated senders.

**Launch status:** the relay adapter is implemented, but it is not connected to a real MLBB data provider. Live automatic results remain disabled until a provider is selected, credentials/webhook delivery are configured, and a real match event is observed end-to-end. The relay alone is not a source of match data.
