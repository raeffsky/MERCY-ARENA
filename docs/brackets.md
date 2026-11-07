# MERCY ARENA brackets

Endpoint: `POST /api/v1/brackets`

Requires a logged-in user. An `organizer` can generate a bracket only for a tournament assigned to their account. The `administrator` permission is accepted only for the platform owner account configured by `BOOTSTRAP_ADMIN_EMAIL`.

Body:

```json
{ "tournament_id": 123 }
```

The tournament must be published or active, have at least two approved team registrations, and have no matches yet. The operation never overwrites an existing match list.

Supported formats:
- `single_elimination`: supports any count from 2 to 32 approved teams. Teams are seeded into the next power-of-two bracket; byes are placed directly into the next round, and only real matches are created. All played matches are linked through `match_progression`.
- `double_elimination`: requires 4, 8, 16 or 32 approved teams. Creates upper and lower brackets, a grand final and a conditional reset final. Advancement routes are stored in `match_advancement` (migration `0016_double_elimination_advancement.sql`).
- `round_robin`: creates every pairwise match in one group.

After a match is completed by a verified result webhook or an organizer's manual result entry, the winner advances and, in Double Elimination, the loser drops into the lower bracket. If the lower-bracket finalist wins the first grand final, the reset final is activated. The tournament is marked completed only after every generated match has a completed result. Cancelled and postponed matches do not count as played results and keep the tournament open. Organizers can reschedule a match by changing `scheduled_at`, mark it `postponed` while a new time is pending, cancel it with `cancelled`, or return it to `scheduled` when it is ready to be played. A match cannot be started until both teams are assigned, and a completed result cannot be cancelled or rescheduled through ordinary editing. Single Elimination supports byes. Double Elimination still requires a full power-of-two team count.


## Correcting a saved result

The platform owner can correct a completed match from the admin match list. The winner is recalculated from the corrected score. If the winner changes, the system walks the configured progression routes. An unplayed scheduled match receives the corrected participant in its slot. If a dependent match has started or finished, the affected branch is invalidated atomically: that match is returned to `scheduled`, its score, winner and verification metadata are cleared, and only the slots fed by invalidated matches are cleared in later rounds. Participants coming from unaffected branches are preserved. The tournament is reopened when a completed non-Circuit bracket needs to be replayed.

Provider result events attached to invalidated matches, including the corrected source match, are marked `reviewed` with a superseded reason. This prevents an old webhook retry from advancing a stale winner. Every match-row write is guarded against concurrent changes, and all branch resets, slot rewrites, event invalidations and audit entries run in one D1 batch.

The first Double Elimination Grand Final also controls the reset final: changing the winner can activate or cancel the reset fixture, but never if that fixture has already started. A completed Double Elimination first final cannot be changed separately from its reset series.

For an already completed MERCY CIRCUIT tournament, a correction is allowed only when it does not require resetting a downstream match that has already been played. Replaying that branch would invalidate the final placements and needs a separate points/season reconciliation policy. When the affected downstream matches are still unplayed, the system recalculates placements from the corrected match list, updates the existing `circuit_tournament_results` rows, and appends only the points difference as a `correction` transaction. Previous award transactions are never deleted or overwritten. Before applying the correction, every result row is checked against its transaction-ledger balance and orphaned ledger entries are rejected; a mismatch stops the operation for manual review. The update to the match, placement rows, point ledger, and audit events is atomic.

Corrections are blocked for qualifier tournaments and after MERCY CHAMPIONSHIP entries have been locked, because those results determine qualification slots that need their own recalculation workflow. Every accepted correction records the previous and new score/winner in the audit log.
