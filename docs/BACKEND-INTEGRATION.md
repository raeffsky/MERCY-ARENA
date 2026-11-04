# MERCY ARENA — backend integration contract

This repository currently deploys a static frontend through GitHub Pages. The UI must never invent tournaments, teams, players, match schedules, scores, rankings, or account state.

## Required services

- API service with persistent database and role-based authorization.
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

The public pages and navigation are implemented in `index.html`. The repository has no API server, database schema, authentication provider, or trusted MLBB result provider configured. GitHub Pages is static hosting and cannot safely run the required background workers or store secrets. The empty states are intentional until a real backend is connected.
