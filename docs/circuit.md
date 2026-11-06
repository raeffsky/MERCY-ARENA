# MERCY CIRCUIT

MERCY CIRCUIT is the season-based, team-only competitive layer of MERCY ARENA.

## Locked season policy

- Scoring: final tournament placement only. Match wins do not directly award Circuit points.
- Season rollover: reset seasonal points to zero by creating a new season. Previous results and transactions remain immutable history.
- Championship: eight teams, six from the final Circuit Ranking and two qualifier winners.
- Ranking scope: teams only.

## Default placement points

| Placement | Points |
|---|---:|
| 1 | 100 |
| 2 | 75 |
| 3-4 | 55 |
| 5-8 | 25 |
| 9-16 | 10 |
| 17+ | 5 |

Season-specific rules in `circuit_scoring_rules` override the defaults. A scoring rule is selected by the team's final placement.

## Result finalization

A tournament is eligible only when it:
- belongs to a season;
- has status `completed`;
- belongs to an `active` or `completed` season;
- has a supported format and complete results;
- has final placements matching every approved tournament registration.

Supported placement derivation:
- Single Elimination: final winner/runner-up, then teams eliminated in each preceding round share the corresponding placement band.
- Double Elimination: grand final winner/runner-up, then lower-bracket eliminations in reverse round order.
- Round Robin: match wins, mini-table head-to-head wins among tied teams, score difference, score-for, then stable team ID.\n\nCircuit Ranking ties are resolved by first places, second places, top-four finishes, head-to-head wins between the tied teams, verified match wins, then stable team ID.

The finalizer runs from the existing tournament-completion path. It is idempotent: one placement result and one `placement_award` transaction per team/tournament. A failed finalization can be retried by invoking the completion path again.

## Ledger model

- `circuit_tournament_results` stores the immutable final placement.
- `circuit_point_transactions` is the points ledger.
- Ranking points are the sum of `points_delta` for a team and season.
- Corrections and reversals are new ledger entries; existing entries must not be silently edited or deleted.
- `circuit_championship_entries` stores the frozen eight-team field and its qualification source.

## Championship qualification

1. Freeze the top six eligible teams at the published ranking-lock timestamp.
2. Qualifier 1 contributes one winner.
3. Qualifier 2 contributes one winner.
4. A team already qualified through the ranking cannot occupy a second slot; the qualifier slot passes to the next eligible finisher in that qualifier.
5. If a team declines or is disqualified, fill the vacancy using the published season regulation and record the decision in the audit log.
6. Freeze eight unique team IDs and seeds before the championship begins.

Qualifier tournaments do not award Circuit points by default and their placement records are excluded from the regular Circuit Ranking. This prevents an extra qualification event from changing the season ranking.

## Existing platform integration

The system reuses `seasons`, `tournaments.season_id`, `teams`, `tournament_registrations`, `matches`, and `audit_events`. It does not create duplicate team or match records.

Migration `0018_mercy_circuit.sql` adds the Circuit scoring, result ledger, qualifier, and championship-entry tables. Production D1 uses legacy INTEGER identifiers for core entities; the migration therefore uses INTEGER foreign-key columns. Verify the target database's schema before applying it.

## Public ranking API

`GET /api/v1/circuit/ranking?season_id=<id>`

Returns the season metadata, team ranking, and any frozen championship entries. It requires migration 0018.
