# Engineering Standard

This document defines the minimum engineering workflow for MERCY ARENA. It applies to every feature, bug fix, migration, and production change.

## 1. Repository safety

- Inspect the current implementation and its callers before editing.
- Reuse existing API routes, authorization helpers, database tables, UI components, and domain services where possible.
- Do not duplicate an existing feature under a second name.
- Work on a dedicated branch. Do not push experimental changes directly to `main`.
- Keep changes scoped. Do not reformat or rewrite unrelated files.
- Never apply, replay, or invent a production D1 migration without checking the live schema and migration history.
- Never modify production data or secrets as part of ordinary development.

## 2. Required implementation cycle

1. **Trace**: identify the UI entry point, API route, authorization boundary, database tables, and downstream effects.
2. **Specify**: write down expected behavior, invalid states, permissions, and failure behavior.
3. **Implement**: make the smallest coherent change; keep business rules server-side.
4. **Test**: add or update regression tests for success, permission denial, invalid input, duplicate requests, and relevant race conditions.
5. **Validate**: run JavaScript syntax checks, production build, and the complete Playwright suite.
6. **Review**: inspect the final diff for accidental changes, unsafe data exposure, missing authorization, and migration hazards.
7. **Deploy**: merge only after CI is green; verify the deployed behavior separately from CI.

## 3. Backend and security rules

- Treat every browser-supplied identifier, role, score, status, timestamp, and ownership claim as untrusted.
- Enforce authorization in the API, not only by hiding buttons in the UI.
- Scope organizer, referee, team, and player access to the exact resource being accessed.
- Validate request method, content type, payload shape, length, enum values, and numeric bounds.
- Use parameterized SQL. Keep multi-step state transitions atomic.
- Make result submission, match progression, scoring, and title changes idempotent where retries are possible.
- Record privileged changes and result corrections in the audit log.
- Do not leak session tokens, secrets, private team data, or internal exception details to clients.
- Prefer secure cookie/session helpers already present in the codebase; do not introduce parallel authentication.

## 4. Database and migration rules

- Read the current schema, relevant migration history, and all queries before changing data structures.
- Migrations must be ordered, forward-only, safe to retry only when explicitly designed as idempotent, and documented.
- Preserve production legacy identifier types unless a separately approved data migration exists.
- Add indexes for new high-cardinality lookup paths when justified.
- Test migrations against a disposable database fixture before any production operation.
- Production backup and restore operations require explicit owner approval.

## 5. Frontend and UX rules

- Preserve the MERCY ARENA visual system: dark premium UI, acid-lime accent, Barlow Condensed and Manrope, and existing Iconify usage.
- Mobile behavior is part of acceptance, not an optional polish pass.
- Every interactive control must have a real action, loading state, success state, and useful error state.
- Provide empty, loading, permission-denied, and failure states.
- Respect role-based visibility, but never treat UI visibility as an authorization boundary.
- Prefer live platform data; never add demo teams, players, tournaments, matches, or scores to production.

## 6. Definition of done

A change is complete only when all applicable items are true:

- [ ] Existing behavior and dependencies were inspected before editing.
- [ ] Acceptance criteria are implemented end to end.
- [ ] Authorization and input validation are enforced server-side.
- [ ] Database changes have reviewed migrations and disposable-fixture coverage.
- [ ] Regression tests cover success and meaningful failure paths.
- [ ] API JavaScript syntax check passes.
- [ ] Production build passes.
- [ ] Full Playwright suite passes on desktop and mobile.
- [ ] Final diff contains no unrelated changes or secrets.
- [ ] CI is green.
- [ ] Production behavior is verified after deployment when deployment is in scope.
- [ ] Any remaining limitation is stated explicitly; untested behavior is never called complete.

## 7. Required test commands

```bash
find functions -name '*.js' -print0 | xargs -0 -n1 sh -c 'node --input-type=module --check < "$0"'
npm run build
npm run test:e2e
```

## 8. Product roadmap: approved, not yet a claim of implementation

The following items are approved roadmap work. Their presence in this list does not mean they are implemented.

### Competitive and tournament operations

- MERCY MATCH ROOM: captain/referee room, match chat, check-in, no-show timer, result submission, dispute workflow.
- MERCY SCHEDULE: captain availability, slot overlap detection, deadline-aware rescheduling.
- MERCY TRUST: separate reliability score for teams and organizers, plus prize payout states and recipient confirmation.
- MERCY LADDER: recurring scrims and Elo-based ranked matchmaking.
- MERCY SCOUT: verified player cards, roles, win rate, MVP and tournament history.
- MERCY ROSTER LOCK: roster freeze after tournament start, controlled substitutions, transfer windows.
- MERCY REFEREE AI: compare submitted result screenshots and prepare discrepancy notes; a human referee retains final authority.
- MERCY PREDICT: spectator predictions using points/badges only, never cash wagering.

### UX and product experience

- Live home dashboard: upcoming tournaments, next matches, recent results, top teams, team registration.
- Mobile-first primary navigation: Home, Tournaments, Matches, Rankings, Profile; secondary destinations under More.
- Plain-language descriptions for branded modules.
- Two-tap access to the next match and its room.
- Rich match card: map scores, draft picks/bans, evidence, dispute action, and result history.
- Public team and player profiles with verified roster and performance history.
- Automatic in-app notification indicators and event feed; push notifications require a separate permission and delivery design.
- Shareable match/team pages with Telegram and Discord Open Graph previews.
- Role-aware personal hub for players, captains, referees, and organizers.

## 9. Delivery order

1. Establish a reliable engineering baseline and audit current behavior.
2. Complete the tournament-to-match-to-confirmed-result-to-rating lifecycle.
3. Deliver the UX foundation: live home, simplified navigation, personal hub, profiles, match cards, notifications, sharing.
4. Deliver MATCH ROOM, SCHEDULE, TRUST, and ROSTER LOCK.
5. Complete SCOUT and LADDER.
6. Add REFEREE AI and PREDICT after data quality, privacy, and abuse controls are established.

Every roadmap item must be split into independently reviewable changes with explicit acceptance criteria.