# MERCY ARENA — backend contract

MERCY ARENA is a tournament platform for Mobile Legends: Bang Bang. The production frontend is deployed through Cloudflare Pages; API handlers are Cloudflare Pages Functions; persistent data lives in Cloudflare D1.

## Deployment model

- Static frontend: `index.html`, built by `bash scripts/build-pages.sh` into `dist/`.
- API: `functions/api/v1/`.
- Database migrations: `migrations/`, applied in numeric order.
- Public UI must show real database data only. It must not invent teams, players, registrations, official fixtures, results or ranking points.
- Demo fixtures, when intentionally shown in a design preview, must be explicitly labelled and must never enter D1 or affect rankings.

## Cloudflare bindings

Required Pages bindings and secrets:

| Name | Type | Purpose |
|---|---|---|
| `DB` | D1 database binding | MERCY ARENA database |
| `APP_BASE_URL` | Environment variable | Canonical origin for origin checks |
| `AUTH_RATE_LIMIT_SALT` | Secret | Hash salt for auth rate limiting |
| `MLBB_LOOKUP_API_KEY` | Secret | Server-side MLBB profile lookup |
| `CLOUDINARY_CLOUD_NAME` | Environment variable | Avatar and media uploads |
| `CLOUDINARY_API_KEY` | Environment variable | Cloudinary API |
| `CLOUDINARY_API_SECRET` | Secret | Cloudinary signing secret |
| `POSTHOG_PROJECT_TOKEN` | Environment variable | Optional browser analytics token |
| `POSTHOG_API_HOST` | Environment variable | Optional analytics host, currently `https://eu.i.posthog.com` |

Never place server-side secrets in frontend JavaScript or commit them to Git.

## Database setup and upgrades

Apply migrations in ascending order. For a fresh database, apply every file from `0001_initial_schema.sql` through the latest numbered migration. For an existing production database, inspect the applied migration history first and apply only migrations that have not already run. Do not rerun ALTER TABLE migrations.

The current platform foundation migration is `0013_platform_foundation.sql`. It adds:
- selected time slot and captain note to tournament registrations;
- per-registration starter and substitute rosters;
- user notifications;
- tournament staff assignments.

The early schema and later compatibility migrations reflect the platform's legacy D1 history. Before rebuilding an existing database, take a D1 backup and verify the actual primary-key types and foreign-key relationships. Do not manually change ID types in production without a data migration and a rollback plan.

## API surface

### Public reads
- `GET /api/v1/health`
- `GET /api/v1/tournaments?status=&format=&season_id=&limit=`
- `GET /api/v1/tournaments?id={id}`
- `GET /api/v1/seasons?limit=`
- `GET /api/v1/teams?query=&limit=`
- `GET /api/v1/teams?id={id}`
- `GET /api/v1/players?query=&role=&limit=`
- `GET /api/v1/players?id={id}`
- `GET /api/v1/matches?tournament_id=&status=&from=&to=&limit=`
- `GET /api/v1/rankings?scope=teams|players&limit=`

Match reads include joined team names, tags and logos. The match API is a fixture and result data contract only; actual game operation and automated MLBB result acquisition are outside the current platform phase.

### Authentication and player account
- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/logout`
- `GET /api/v1/me`
- `PUT /api/v1/players` — verify/update the current MLBB player profile
- `POST /api/v1/avatar` — upload the current player's avatar

Passwords are hashed server-side with PBKDF2-SHA-256. Sessions use HttpOnly, Secure, SameSite=Lax cookies. Authenticated write routes enforce same-origin checks and server-side role checks.

### Teams
- `GET /api/v1/teams`
- `POST /api/v1/teams` — create a team for an approved player
- `GET /api/v1/team-members?team_id={id}` — pending invites for a captain
- `GET /api/v1/team-members` — current player's pending invites
- `POST /api/v1/team-members` — invite a player or transfer captaincy
- `PUT /api/v1/team-members` — accept or decline an invite
- `DELETE /api/v1/team-members` — remove a member or leave a team

Team membership is limited to seven active players. A tournament application requires five to seven approved team members.

### Tournament applications
- `GET /api/v1/applications?tournament_id={id}` — captain's teams, eligible players and existing application state.
- `POST /api/v1/applications` — submit a team, selected player IDs, optional time slot and captain note.
- `PUT /api/v1/applications` — withdraw a pending application.
- `GET /api/v1/notifications` — current user's inbox and unread count.
- `PUT /api/v1/notifications` — mark one notification or all notifications as read.

The application API validates captain ownership, registration dates, tournament capacity, team membership, approved player profiles, duplicate player IDs and roster size. The first five selected players are starters; additional selected players are substitutes.

### Organizer and administration
- `GET /api/v1/admin?resource={tournaments|teams|players|matches|seasons|applications|users}`
- `POST /api/v1/admin` — create/update/delete records, publish tournaments, review applications.
- `POST /api/v1/brackets` — generate supported tournament fixture structures.
- `POST /api/v1/uploads/tournament-poster`
- `POST /api/v1/uploads/season-cover`

Admin operations are restricted by server-side roles and are audited. Application decisions generate a notification for the team captain. The organizer workflow manages tournament configuration, registrations and fixture structures. It does not run matches.

## Rankings

Team rankings are calculated from completed matches with a verified result timestamp. Unverified or provisional results do not affect the ladder. Individual player ranking points, tiers and season scoring are intentionally not fabricated; those require a defined competition scoring policy and trusted match data.

## Match implementation boundary

This phase prepares the platform around matches: tournament fixture records, bracket metadata, registration rosters, schedules, standings data contracts and organizer access. It does not implement live match rooms, check-in, referee live operations, game client integration, automated result detection or match simulation. Those require a separate product and technical design.

## Quality checks

Run locally:

```bash
npm install
npx playwright install chromium
npm run build
npm run test:e2e
```

GitHub Actions runs desktop and mobile smoke tests on pushes to `main` and pull requests. The current smoke suite covers page rendering, homepage sections, navigation and the mobile drawer. It is not a substitute for end-to-end tests against a provisioned D1 database.

## Operational checklist

1. Confirm the Pages project is connected to `raeffsky/MERCY-ARENA`, production branch `main`, build command `bash scripts/build-pages.sh`, output directory `dist`.
2. Confirm the D1 binding name is exactly `DB` for Production and Preview environments as needed.
3. Apply outstanding migrations in order after taking a backup.
4. Configure the server-side environment variables and secrets above.
5. Verify `GET /api/v1/health`, registration, login, profile retrieval, team creation and tournament application flows against the deployed environment.
6. Verify an organizer can review an application and the captain receives an inbox notification.
