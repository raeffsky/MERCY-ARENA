# MERCY MATCH

MERCY MATCH is the private operations room for a scheduled MLBB match. It coordinates the custom room, team readiness, referee contact and verified result.

## Access

- Assigned referees can open the private Referee Dashboard at `/referee.html`; it lists only matches from tournaments where they hold the `referee` staff role.
- Players with an approved profile and active membership in either match team can read the room.
- The team captain can confirm readiness for their own side.
- The tournament organizer and assigned tournament staff with the `organizer` or `admin` role can configure the room and reset readiness.
- An assigned `referee` can configure the room, reset readiness and verify the match result.
- An assigned `observer` has read-only access.
- The platform owner has full access.
- Staff permissions are scoped to one tournament through `tournament_staff`; a global judge role alone does not grant access.

## Room lifecycle

1. The organizer or referee selects BO1, BO3 or BO5 and enters the MLBB Custom Room ID and password.
2. The credentials stay hidden from participants until the staff member publishes them.
3. Captains confirm readiness for their own teams.
4. Staff can reset readiness if the match is delayed or a team must reconnect.
5. After the game, the assigned referee submits the score. The score is the number of maps won: BO1 requires 1 win, BO3 requires 2, and BO5 requires 3. The opposing team's captain must confirm the submitted score before the match is finalized and the winner advances through the bracket. The captain may dispute the result with a required reason; the dispute is sent to the tournament organizer.
6. An organizer resolves disputed results by recording the final score. Every submission, confirmation, dispute and organizer resolution is written to the audit log. If finalization succeeds but bracket progression fails, the organizer can retry progression without changing the verified result.

Room credentials and readiness controls are available only while the tournament is published and the match is scheduled or in progress. Credentials are hidden after the match is no longer active.

## Important limitation

MERCY ARENA does not create the in-game MLBB Custom Room. The organizer or referee creates it in Mobile Legends, then enters its ID and password in MERCY MATCH. The platform securely coordinates access and operations around that room.

## Tournament check-in

When `checkin_required` is enabled, each approved team must be checked in by its captain before confirming match readiness. The default window opens 60 minutes before `starts_at` and closes 15 minutes after it; organizers may override both timestamps. An organizer, tournament administrator or referee can mark a team as a no-show after the window closes, excuse it, or reset the attendance state. A team marked `excused` may still confirm match readiness.

Check-in records are stored per tournament and team, with actor, timestamp and audit history. The match room refuses a captain's readiness confirmation until their team is checked in or excused.

After the check-in window closes, staff can mark a team as a no-show. A referee can award a technical forfeit only when the opponent is checked in or excused; the forfeit is recorded as a verified result and advances the present team automatically. If both teams are absent, the system does not guess a winner.

## Result confirmation states

- `pending`: referee submitted a score; only the captain of the opposing team can confirm or dispute it.
- `confirmed`: the opposing captain confirmed the score; the match is completed and bracket progression runs.
- `disputed`: the opposing captain supplied a reason; the organizer must resolve the dispute before the match can be completed.
- A referee cannot overwrite a pending, confirmed or disputed submission. Corrections to finalized results remain an organizer/platform-owner operation with an audit trail.
