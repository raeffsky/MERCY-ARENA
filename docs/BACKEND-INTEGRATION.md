# MERCY ARENA — backend integration contract

The frontend is deployed through Cloudflare Pages. The first backend layer uses Cloudflare Pages Functions and Cloudflare D1. The UI must never invent tournaments, teams, players, match schedules, scores, rankings, or account state.

## Current backend foundation

- Pages Functions API routes live under `functions/api/v1/`.
- Initial D1 schema is in `migrations/0001_initial_schema.sql`.
- The API exposes public read endpoints for tournaments, teams, players, matches, seasons, rankings, and health.
- Bind the D1 database to the Pages project using the binding name `DB` before expecting data routes to return records.
- No organizer write routes are enabled until authentication and server-side role checks are configured.

## Required next services

- Organizer identity provider. Roles: player, team captain, organizer, referee, administrator.
- Trusted match-result provider for MLBB. No official provider credentials or documented public endpoint are configured in this repository.
- Background worker for polling/webhooks, validation, idempotency, and retry handling.

## Suggested API surface

All responses are JSON. All timestamps are ISO-8601 UTC. Every list endpoint supports cursor pagination.

- GET /api/v1/tournaments?status=&format=&cursor=
- GET /api/v1/tournaments/{id}
- GET /api/v1/teams?query=&cursor=
- GET /api/v1/teams/{id}
- GET /api/v1/players?query=&role=&cursor=
- GET /api/v1/players/{id}
- GET /api/v1/matches?status=&tournament_id=&from=&to=&cursor=
- GET /api/v1/matches/{id}
- GET /api/v1/rankings?scope=teams|players&season_id=
- GET /api/v1/seasons
- POST /api/v1/organizer/tournaments
- PATCH /api/v1/organizer/tournaments/{id}
- POST /api/v1/organizer/tournaments/{id}/registrations
- POST /api/v1/organizer/matches/{id}/result-review
- POST /api/v1/organizer/matches/{id}/confirm-result

## Core entities

- Tournament: id, title, game, region, format, status, registration_open_at, registration_close_at, starts_at, rules_url, organizer_id.
- Team: id, name, tag, logo_url, captain_id, roster.
- Player: id, game_id, nickname, role, team_id.
- Match: id, tournament_id, round, scheduled_at, status, team_a_id, team_b_id, score_a, score_b, result_source, result_verified_at.
- ResultEvent: provider_event_id, match_id, payload_hash, received_at, validation_status, reviewer_id, decision_reason.
- Season: id, title, starts_at, ends_at, status.

## Result ingestion rules

1. Accept provider webhooks only after signature verification. If the provider has no webhook support, poll its documented API from a server-side worker.
2. Resolve provider match IDs to internal match IDs. Never match on team display names alone.
3. Validate that the event is final, both participants match the scheduled fixture, and the score is structurally valid.
4. Make ingestion idempotent using provider_event_id and payload_hash.
5. Store raw provider payloads and an audit trail. Do not overwrite a previously confirmed result silently.
6. Send ambiguous, conflicting, or incomplete events to referee review.
7. Update match, bracket progression, standings, and rankings in one database transaction only after confirmation.
8. Expose the result source and verification state to the public UI.

## Security requirements

- Provider secrets stay on the server and never in frontend JavaScript or Git.
- Organizer and referee endpoints require server-side role checks.
- Rate-limit public and authenticated endpoints.
- Record audit events for tournament edits, result changes, and referee decisions.
- Use database constraints and transactions for roster limits, registration deadlines, bracket progression, and duplicate result prevention.

## Current implementation boundary

The public pages and navigation are implemented in `index.html`. The API and database schema are now scaffolded, but the D1 database binding and migration still need to be provisioned in Cloudflare. Authentication, organizer write operations, and a trusted MLBB result provider are not yet configured. Public pages must keep their honest empty states until real records exist. Secrets must remain in server-side Cloudflare bindings, never in frontend JavaScript or Git.


## Initial D1 setup

1. Create a Cloudflare D1 database named `mercy-arena-db`.
2. In Cloudflare Pages → `mercy-arena` → Settings → Functions → D1 database bindings, add binding `DB` and select `mercy-arena-db` for production (and preview if required).
3. Apply `migrations/0001_initial_schema.sql` to that database.
4. Verify `GET /api/v1/health` returns `{"status":"ready","database":"connected"}`.
5. Verify the public list endpoints return empty arrays until real data is entered.

Do not enable organizer write endpoints until identity verification, role checks, CSRF/origin controls, rate limits, and audit logging are implemented.
