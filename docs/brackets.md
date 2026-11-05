# MERCY ARENA brackets

Endpoint: `POST /api/v1/brackets`

Requires a logged-in user with the `administrator` or `organizer` role. Organizers can generate a bracket only for their own tournament.

Body:

```json
{ "tournament_id": 123 }
```

The tournament must be published or active, have at least two approved team registrations, and have no matches yet. The operation never overwrites an existing match list.

Supported formats:
- `single_elimination`: currently requires a full bracket size of 2, 4, 8, 16 or 32 approved teams. All rounds are created and linked through `match_progression`.
- `round_robin`: creates every pairwise match in one group.

After a match is completed by a verified result webhook or an organizer's manual result entry, the winner is moved into the linked slot in the next round. Results are not fabricated for empty slots or byes; the first version therefore requires a full single-elimination bracket.
