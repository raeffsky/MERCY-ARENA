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

The match must already exist in MERCY ARENA and its team IDs must match the event. Ties, unknown matches, mismatched teams and replayed events are rejected. A valid signed event is stored in `result_events`, marks the match completed, sets its winner and verification timestamp, and writes an audit event. Repeated delivery of the same provider event is idempotent.

## Signature

Use the raw UTF-8 request body exactly as sent.

1. Set `timestamp` to the current Unix time in seconds.
2. Compute HMAC-SHA256 using `MATCH_RESULTS_WEBHOOK_SECRET` over `timestamp + "." + rawBody`.
3. Send lowercase hex digest in `x-mercy-signature`.
4. Send timestamp in `x-mercy-timestamp`.

Requests older than five minutes are rejected.

## Provider integration status

The receiving endpoint and validation contract are implemented. Automatic results become live only after a real provider or relay is configured to send signed events. The platform must not invent results or treat unverified client submissions as official.
