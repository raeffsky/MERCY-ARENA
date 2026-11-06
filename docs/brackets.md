# MERCY ARENA brackets

Endpoint: `POST /api/v1/brackets`

Requires a logged-in user. An `organizer` can generate a bracket only for a tournament assigned to their account. The `administrator` permission is accepted only for the platform owner account configured by `BOOTSTRAP_ADMIN_EMAIL`.

Body:

```json
{ "tournament_id": 123 }
```

The tournament must be published or active, have at least two approved team registrations, and have no matches yet. The operation never overwrites an existing match list.

Supported formats:
- `single_elimination`: currently requires a full bracket size of 2, 4, 8, 16 or 32 approved teams. All rounds are created and linked through `match_progression`.
- `double_elimination`: requires 4, 8, 16 or 32 approved teams. Creates upper and lower brackets, a grand final and a conditional reset final. Advancement routes are stored in `match_advancement` (migration `0016_double_elimination_advancement.sql`).
- `round_robin`: creates every pairwise match in one group.

After a match is completed by a verified result webhook or an organizer's manual result entry, the winner advances and, in Double Elimination, the loser drops into the lower bracket. If the lower-bracket finalist wins the first grand final, the reset final is activated. The tournament is marked completed only after every match is completed or cancelled. Bracket generation currently requires full team counts without byes.
