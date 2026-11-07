# Production operations: D1 backup and recovery

This runbook is for the production D1 database used by MERCY ARENA. It deliberately does not run a restore, apply migrations, or export production data automatically. Those actions need the real database binding name and an operator-controlled secure destination.

## 1. Identify the production database

The D1 binding is configured in the Cloudflare Pages project settings, not in this repository. In Cloudflare Dashboard:

1. Open **Workers & Pages → mercy-arena → Settings → Functions → D1 database bindings**.
2. Record the binding name and the attached database name/ID.
3. Confirm that the production deployment uses this binding, not a preview or local database.

Then authenticate Wrangler with the Cloudflare account that owns the project and run:

```bash
npx wrangler@latest d1 info <DB_NAME>
```

Inspect the `version` field:

- `production`: the database uses the current D1 storage subsystem and supports Time Travel.
- `alpha`: it uses the legacy snapshot backup system; do not assume Time Travel is available.

Do not put database IDs, API tokens, or exported production data in Git.

## 2. Point-in-time recovery (Time Travel)

For D1 databases on the production storage subsystem, Time Travel is enabled automatically. It creates recovery bookmarks without a scheduled job. Retention is plan-dependent: up to 7 days on Workers Free and up to 30 days on Workers Paid.

Check the current bookmark:

```bash
npx wrangler@latest d1 time-travel info <DB_NAME>
```

Check the database state at a known UTC timestamp:

```bash
npx wrangler@latest d1 time-travel info <DB_NAME> --timestamp="2026-11-07T00:00:00Z"
```

Time Travel is the fast recovery path for accidental writes or a failed migration while the required point is still within the retention window. It is not a substitute for a separately stored export if longer retention is required.

## 3. Create an independent SQL export

Create an export before every production migration/release that changes schema or data, and keep a recurring off-platform copy (weekly is a reasonable starting cadence):

```bash
mkdir -p ./secure-backups
npx wrangler@latest d1 export <DB_NAME> --remote --output="./secure-backups/mercy-arena-$(date -u +%Y%m%dT%H%M%SZ).sql"
sha256sum ./secure-backups/*.sql
```

The export contains schema and production data. Treat it as sensitive: store it in encrypted storage with restricted access, keep it out of the repository, and do not attach it to public issues or pull requests.

Cloudflare documents that a running D1 export blocks other database requests. Schedule it during a quiet period, especially once the platform has active tournaments.

## 4. Recovery procedure (operator approval required)

**Restoring overwrites the live database.** Never run the command below as an automated CI step or as part of an ordinary deployment.

Before restoring:

1. Stop or pause writes to MERCY ARENA.
2. Create and securely store a fresh SQL export of the current database.
3. Identify the exact incident time in UTC and check the matching Time Travel bookmark.
4. Confirm the target database name/ID and the restore timestamp with the platform owner.
5. Record the current bookmark so the restore can be undone if necessary.

Only after explicit approval:

```bash
npx wrangler@latest d1 time-travel restore <DB_NAME> --timestamp="YYYY-MM-DDTHH:MM:SSZ"
```

Record both the returned bookmark and the previous bookmark. Validate schema, migration history, users, teams, registrations, matches, result events, Circuit point transactions, and public API health before reopening writes. Do not re-run migrations blindly after a restore.

If Time Travel is unavailable (legacy alpha storage), use the matching legacy backup workflow and verify the available backup ID before restoring.

## 5. Operational checklist

- [ ] Production D1 binding name and database ID recorded in the private operations vault.
- [ ] `wrangler d1 info` confirms the actual storage version and plan retention is known.
- [ ] Time Travel bookmark check completed after a release or migration.
- [ ] Independent encrypted SQL export stored outside Git at the agreed cadence.
- [ ] Export checksum recorded.
- [ ] Restore procedure and access permissions reviewed by the platform owner.
- [ ] A restore drill has been completed against a separate test database, never against production.

## Current verification status

The MERCY ARENA production API was reachable and reported D1 as connected during the latest smoke test. This confirms application connectivity only. The repository workflow does not have access to the Cloudflare account settings, so the production database name, storage version, Time Travel retention, backup destination, and restore permissions have **not** been independently verified yet.
