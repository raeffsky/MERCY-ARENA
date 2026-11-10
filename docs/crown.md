# MERCY CROWN

MERCY CROWN is the persistent championship title system of MERCY ARENA. A single active reign represents the current champion. The title changes hands only after a scheduled defense is decided from a verified match result.

## Rules and state model

- At most one reign may have `ended_at IS NULL`.
- A champion must be an active, non-archived team.
- A challenger must be a different active, non-archived team.
- A defense must reference a scheduled or in-progress match between the exact champion and challenger.
- The match must belong to a published tournament.
- A reign may have only one scheduled defense at a time. D1 enforces this with the partial unique index `idx_mercy_crown_one_scheduled_challenge`.
- A defense can be resolved only after the match is completed and `result_verified_at` is set.
- If the champion wins, the current reign continues and its defense counter increments.
- If the challenger wins, the old reign closes and a new reign begins for the challenger.
- A scheduled defense may be cancelled by the platform owner if the match or event is cancelled or must be replaced. Cancellation is audited and releases the reign's pending-defense slot.

## Permissions

All mutations are restricted to the platform owner account with the administrator role. Public users can read the current champion, reign history and defense history.

## Data and migrations

- `0021_mercy_crown.sql` creates reign and challenge history.
- `0022_mercy_crown_single_pending_challenge.sql` enforces one scheduled challenge per reign.
- Every appointment, scheduled defense, resolution and cancellation writes an audit event.

The API is `/api/v1/crown`. Mutations use POST actions: `appoint_champion`, `schedule_challenge`, `resolve_challenge` and `cancel_challenge`.
