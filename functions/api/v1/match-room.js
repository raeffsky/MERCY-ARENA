import { json, databaseUnavailable } from "./_lib/http.js";
import { advanceWinner } from "./_lib/match-progression.js";
import { getSessionUser, isOwnerAccount, sameOrigin } from "./_lib/session-auth.js";
import { createAuditEventId } from "./_lib/audit.js";

const fail = (code, message, status = 400) => json({ error: { code, message } }, status);
const now = () => new Date().toISOString();
const FORMATS = new Set(["BO1", "BO3", "BO5"]);
async function audit(db, actor, action, matchId, details) {
  await db.prepare("INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,after_json) VALUES (?,?,?,?,?,?)")
    .bind(await createAuditEventId(db), actor, action, "match_room", String(matchId), JSON.stringify(details || {})).run();
}

async function loadMatch(db, id) {
  return db.prepare(
    "SELECT m.id,m.tournament_id,m.round_number,m.bracket,m.match_number,m.scheduled_at,m.status," +
    "m.team_a_id,m.team_b_id,m.score_a,m.score_b,m.winner_team_id,m.result_source,m.result_verified_at," +
    "ta.name AS team_a_name,tb.name AS team_b_name,t.organizer_id,t.status AS tournament_status,t.published_at AS tournament_published_at,t.checkin_required,t.title AS tournament_title " +
    "FROM matches m JOIN tournaments t ON t.id=m.tournament_id " +
    "LEFT JOIN teams ta ON ta.id=m.team_a_id LEFT JOIN teams tb ON tb.id=m.team_b_id WHERE m.id=? LIMIT 1"
  ).bind(id).first();
}

async function accessFor(db, user, match, env) {
  const owner = user.roles.includes("administrator") && isOwnerAccount(user, env);
  const staff = await db.prepare("SELECT staff_role FROM tournament_staff WHERE tournament_id=? AND user_id=? LIMIT 1")
    .bind(match.tournament_id, user.id).first().catch(() => null);
  const organizer = owner || String(match.organizer_id) === String(user.id) || ["organizer", "admin"].includes(staff?.staff_role);
  const judge = staff?.staff_role === "referee";
  const observer = staff?.staff_role === "observer";
  const player = await db.prepare(
    "SELECT p.id,p.team_id,t.captain_id FROM players p " +
    "JOIN teams t ON t.id=p.team_id AND t.status='active' AND t.archived_at IS NULL " +
    "WHERE p.user_id=? AND p.profile_status='approved' AND p.archived_at IS NULL " +
    "AND EXISTS (SELECT 1 FROM team_roster tr WHERE tr.player_id=p.id AND tr.team_id=t.id AND tr.left_at IS NULL) LIMIT 1"
  ).bind(user.id).first().catch(() => null);
  const roster = player ? await db.prepare(
    "SELECT team_id FROM team_roster WHERE player_id=? AND left_at IS NULL AND team_id IN (?,?) AND team_id=?"
  ).bind(player.id, match.team_a_id || "", match.team_b_id || "", player.team_id || "").all() : { results: [] };
  const teamIds = (roster.results || []).map(row => String(row.team_id));
  const captainA = !!(player && String(match.team_a_id) && String(player.team_id) === String(match.team_a_id) && String(player.captain_id) === String(user.id));
  const captainB = !!(player && String(match.team_b_id) && String(player.team_id) === String(match.team_b_id) && String(player.captain_id) === String(user.id));
  const participant = teamIds.length > 0 || captainA || captainB;
  return { owner, organizer, judge, observer, participant, canManage: owner || organizer || judge, canReady: captainA || captainB,
    side: captainA ? "a" : captainB ? "b" : teamIds.includes(String(match.team_a_id)) ? "a" : teamIds.includes(String(match.team_b_id)) ? "b" : null };
}

function publicRoom(match, room, access, submission = null) {
  const tournamentActive = !!match.tournament_published_at && ["published", "active"].includes(match.tournament_status);
  const matchActive = tournamentActive && ["scheduled", "in_progress"].includes(match.status);
  const credentialsVisible = !!room && matchActive && (access.canManage || !!room.room_published_at);
  return {
    match: { id: match.id, tournament_id: match.tournament_id, tournament_title: match.tournament_title,
      round_number: match.round_number, bracket: match.bracket, match_number: match.match_number,
      scheduled_at: match.scheduled_at, status: match.status, team_a_id: match.team_a_id,
      team_b_id: match.team_b_id, team_a_name: match.team_a_name, team_b_name: match.team_b_name },
    room: room ? { series_format: room.series_format, room_id: credentialsVisible ? room.room_id : null,
      room_password: credentialsVisible ? room.room_password : null, published: !!room.room_published_at && matchActive,
      judge_contact: room.judge_contact, instructions: room.instructions,
      team_a_ready: !!room.team_a_ready_at, team_b_ready: !!room.team_b_ready_at,
      team_a_ready_at: room.team_a_ready_at, team_b_ready_at: room.team_b_ready_at } :
      { series_format: "BO1", room_id: null, room_password: null, published: false, judge_contact: null,
        instructions: null, team_a_ready: false, team_b_ready: false },
    result_submission: submission ? { status: submission.status, score_a: submission.score_a, score_b: submission.score_b, winner_team_id: submission.winner_team_id, confirming_team_id: submission.confirming_team_id, submitted_at: submission.submitted_at, dispute_reason: submission.dispute_reason, decided_at: submission.decided_at } : null,
    permissions: { can_manage: access.canManage && matchActive, can_ready: access.canReady && matchActive, can_verify_result: (access.owner || access.organizer || access.judge) && tournamentActive && matchActive, can_confirm_result: !!submission && submission.status === "pending" && access.canReady && String(access.side === "a" ? match.team_a_id : match.team_b_id) === String(submission.confirming_team_id), can_dispute_result: !!submission && submission.status === "pending" && access.canReady && String(access.side === "a" ? match.team_a_id : match.team_b_id) === String(submission.confirming_team_id), can_resolve_result: (access.owner || access.organizer) && !!submission && submission.status === "disputed", side: access.side }
  };
}

async function authorize(request, env, id) {
  if (!env.DB) return { response: databaseUnavailable() };
  const auth = await getSessionUser(request, env);
  if (auth.error) return { response: auth.error };
  if (!auth.user) return { response: fail("UNAUTHORIZED", "Войди в аккаунт, чтобы открыть комнату матча.", 401) };
  const match = await loadMatch(env.DB, id);
  if (!match) return { response: fail("MATCH_NOT_FOUND", "Матч не найден.", 404) };
  const access = await accessFor(env.DB, auth.user, match, env);
  if (!access.canManage && !access.participant && !access.observer) return { response: fail("MATCH_ACCESS_DENIED", "Комната доступна только участникам матча, персоналу турнира и администратору.", 403) };
  return { db: env.DB, user: auth.user, match, access };
}

export async function onRequestGet({ request, env }) {
  const id = new URL(request.url).searchParams.get("id")?.trim();
  if (!id || id.length > 128) return fail("INVALID_MATCH", "Некорректный ID матча.");
  const auth = await authorize(request, env, id);
  if (auth.response) return auth.response;
  try {
    const room = await auth.db.prepare("SELECT * FROM match_rooms WHERE match_id=?").bind(id).first();
    return json({ data: publicRoom(auth.match, room, auth.access) }, 200, { "Cache-Control": "no-store, private" });
  } catch (error) {
    console.error("MERCY MATCH room read failed:", error);
    return fail("MATCH_ROOM_READ_FAILED", "Не удалось загрузить игровую комнату.", 500);
  }
}

export async function onRequestPost({ request, env }) {
  if (!request.headers.get("origin") || !sameOrigin(request, env)) return fail("ORIGIN_REJECTED", "Запрос отклонён.", 403);
  let body;
  try { body = await request.json(); } catch { return fail("INVALID_JSON", "Некорректный JSON."); }
  const id = String(body?.match_id || "").trim();
  if (!id || id.length > 128) return fail("INVALID_MATCH", "Некорректный ID матча.");
  const auth = await authorize(request, env, id);
  if (auth.response) return auth.response;
  const { db, user, match, access } = auth;
  const action = String(body.action || "");
  const timestamp = now();
  try {
    if (action === "configure") {
      if (!access.canManage) return fail("MANAGER_REQUIRED", "Настраивать комнату может организатор, судья или администратор.", 403);
      if (!match.tournament_published_at || !["published", "active"].includes(match.tournament_status)) return fail("TOURNAMENT_NOT_PUBLISHED", "Комнату можно настраивать только для опубликованного турнира.", 409);
      if (!["scheduled", "in_progress"].includes(match.status)) return fail("MATCH_NOT_CONFIGURABLE", "Комнату можно настраивать только для запланированного или текущего матча.", 409);
      const data = body.data && typeof body.data === "object" ? body.data : {};
      const format = String(data.series_format || "BO1").toUpperCase();
      if (!FORMATS.has(format)) return fail("INVALID_FORMAT", "Формат серии должен быть BO1, BO3 или BO5.");
      const roomId = String(data.room_id || "").trim();
      const password = String(data.room_password || "").trim();
      const judge = String(data.judge_contact || "").trim();
      const instructions = String(data.instructions || "").trim();
      if (roomId.length > 80 || password.length > 80 || judge.length > 160 || instructions.length > 1200)
        return fail("FIELD_TOO_LONG", "Проверь длину полей комнаты.");
      if (!!roomId !== !!password) return fail("ROOM_CREDENTIALS_REQUIRED", "Укажи одновременно ID и пароль комнаты либо очисти оба поля.");
      const publishedAt = data.publish && roomId && password ? timestamp : null;
      const previousRoom = await db.prepare("SELECT series_format,room_id,room_password FROM match_rooms WHERE match_id=?").bind(id).first();
      const readinessReset = !!previousRoom && (format !== previousRoom.series_format || roomId !== String(previousRoom.room_id || "") || password !== String(previousRoom.room_password || ""));
      await db.prepare(
        "INSERT INTO match_rooms (match_id,series_format,room_id,room_password,room_published_at,judge_contact,instructions,created_by,created_at,updated_at) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(match_id) DO UPDATE SET " +
        "team_a_ready_at=CASE WHEN match_rooms.series_format<>excluded.series_format OR COALESCE(match_rooms.room_id,'')<>COALESCE(excluded.room_id,'') OR COALESCE(match_rooms.room_password,'')<>COALESCE(excluded.room_password,'') THEN NULL ELSE match_rooms.team_a_ready_at END," +
        "team_b_ready_at=CASE WHEN match_rooms.series_format<>excluded.series_format OR COALESCE(match_rooms.room_id,'')<>COALESCE(excluded.room_id,'') OR COALESCE(match_rooms.room_password,'')<>COALESCE(excluded.room_password,'') THEN NULL ELSE match_rooms.team_b_ready_at END," +
        "series_format=excluded.series_format,room_id=excluded.room_id,room_password=excluded.room_password," +
        "room_published_at=excluded.room_published_at,judge_contact=excluded.judge_contact,instructions=excluded.instructions,updated_at=excluded.updated_at"
      ).bind(id, format, roomId || null, password || null, publishedAt, judge || null, instructions || null, user.id, timestamp, timestamp).run();
      const room = await db.prepare("SELECT * FROM match_rooms WHERE match_id=?").bind(id).first();
      await audit(db, user.id, "match_room_configured", id, { series_format: format, published: !!publishedAt, readiness_reset: readinessReset });
      return json({ data: publicRoom(match, room, access) }, 200, { "Cache-Control": "no-store, private" });
    }
    if (action === "ready") {
      if (!access.canReady || !access.side) return fail("CAPTAIN_REQUIRED", "Готовность может подтвердить только капитан одной из команд.", 403);
      if (!match.tournament_published_at || !["published", "active"].includes(match.tournament_status)) return fail("TOURNAMENT_NOT_PUBLISHED", "Готовность доступна только в опубликованном турнире.", 409);
      if (!["scheduled", "in_progress"].includes(match.status)) return fail("MATCH_NOT_READY", "Подтвердить готовность можно только для запланированного или текущего матча.", 409);
      if (match.checkin_required) {
        const teamId = access.side === "a" ? match.team_a_id : match.team_b_id;
        const checkin = await db.prepare("SELECT c.status FROM tournament_checkins c JOIN tournament_registrations r ON r.id=c.registration_id AND r.status='approved' WHERE c.tournament_id=? AND c.team_id=?").bind(match.tournament_id,teamId).first();
        if (!checkin || !["checked_in","excused"].includes(checkin.status)) return fail("TEAM_NOT_CHECKED_IN", "Сначала капитан должен подтвердить участие команды через check-in.", 409);
      }
      const column = access.side === "a" ? "team_a_ready_at" : "team_b_ready_at";
      await db.prepare(
        "INSERT INTO match_rooms (match_id,created_by,created_at,updated_at) VALUES (?,?,?,?) " +
        "ON CONFLICT(match_id) DO NOTHING"
      ).bind(id, user.id, timestamp, timestamp).run();
      await db.prepare("UPDATE match_rooms SET " + column + "=COALESCE(" + column + ",?),updated_at=? WHERE match_id=?")
        .bind(timestamp, timestamp, id).run();
      const room = await db.prepare("SELECT * FROM match_rooms WHERE match_id=?").bind(id).first();
      await audit(db, user.id, "match_team_ready", id, { side: access.side });
      return json({ data: publicRoom(match, room, access) }, 200, { "Cache-Control": "no-store, private" });
    }
    if (action === "reset_ready") {
      if (!access.canManage) return fail("MANAGER_REQUIRED", "Сбросить готовность может организатор, судья или администратор.", 403);
      if (!match.tournament_published_at || !["published", "active"].includes(match.tournament_status)) return fail("TOURNAMENT_NOT_PUBLISHED", "Готовность доступна только в опубликованном турнире.", 409);
      if (!["scheduled", "in_progress"].includes(match.status)) return fail("MATCH_NOT_READY", "Готовность можно сбрасывать только для запланированного или текущего матча.", 409);
      const side = String(body.side || "both");
      if (!["a", "b", "both"].includes(side)) return fail("INVALID_SIDE", "Некорректная сторона матча.");
      const resetWrites = [];
      if (side === "a" || side === "both") resetWrites.push(db.prepare("UPDATE match_rooms SET team_a_ready_at=NULL,updated_at=? WHERE match_id=?").bind(timestamp,id));
      if (side === "b" || side === "both") resetWrites.push(db.prepare("UPDATE match_rooms SET team_b_ready_at=NULL,updated_at=? WHERE match_id=?").bind(timestamp,id));
      if (resetWrites.length) await db.batch(resetWrites);
      const room = await db.prepare("SELECT * FROM match_rooms WHERE match_id=?").bind(id).first();
      await audit(db, user.id, "match_readiness_reset", id, { side });
      return json({ data: publicRoom(match, room, access) }, 200, { "Cache-Control": "no-store, private" });
    }
    if (action === "forfeit_no_show") {
      if (!access.owner && !access.organizer && !access.judge) return fail("REFEREE_REQUIRED", "Техническое поражение может назначить только организатор или судья.", 403);
      if (!match.checkin_required) return fail("CHECKIN_DISABLED", "В этом турнире check-in не обязателен.", 409);
      if (!match.tournament_published_at || !["published", "active"].includes(match.tournament_status)) return fail("TOURNAMENT_NOT_ACTIVE", "Техническое поражение доступно только в опубликованном турнире.", 409);
      const absentTeamId = String(body.team_id || "");
      if (![String(match.team_a_id),String(match.team_b_id)].includes(absentTeamId)) return fail("INVALID_FORFEIT_TEAM", "Команда не участвует в этом матче.");
      const opponentTeamId = absentTeamId === String(match.team_a_id) ? match.team_b_id : match.team_a_id;
      const winner = opponentTeamId;
      const roomConfig = await db.prepare("SELECT series_format FROM match_rooms WHERE match_id=?").bind(id).first();
      const targetWins = ({ BO1: 1, BO3: 2, BO5: 3 })[roomConfig?.series_format || "BO1"] || 1;
      const scoreA = absentTeamId === String(match.team_a_id) ? 0 : targetWins;
      const scoreB = absentTeamId === String(match.team_b_id) ? 0 : targetWins;
      if (match.status === "completed" && match.result_source === "no_show_forfeit" && String(match.winner_team_id) === String(winner)) {
        try {
          const progression = await advanceWinner(db,id,winner);
          const updatedMatch = await loadMatch(db,id);
          const room = await db.prepare("SELECT * FROM match_rooms WHERE match_id=?").bind(id).first();
          return json({ data: publicRoom(updatedMatch,room,access), progression, progression_retried:true },200,{"Cache-Control":"no-store, private"});
        } catch (error) {
          console.error("MERCY MATCH forfeit progression retry failed:",error);
          return fail("RESULT_SAVED_PROGRESSION_PENDING","Техническое поражение уже сохранено. Повтори продвижение победителя позже.",503);
        }
      }
      if (!["scheduled","in_progress"].includes(match.status)) return fail("MATCH_NOT_PLAYABLE","Техническое поражение можно назначить только для текущего матча.",409);
      const checkin = await db.prepare("SELECT c.status FROM tournament_checkins c JOIN tournament_registrations r ON r.id=c.registration_id AND r.status='approved' WHERE c.tournament_id=? AND c.team_id=?").bind(match.tournament_id,absentTeamId).first();
      if (!checkin || checkin.status !== "no_show") return fail("NO_SHOW_NOT_CONFIRMED", "Сначала отметь команду как неявившуюся в check-in.", 409);
      const opponentCheckin = await db.prepare("SELECT c.status FROM tournament_checkins c JOIN tournament_registrations r ON r.id=c.registration_id AND r.status='approved' WHERE c.tournament_id=? AND c.team_id=?").bind(match.tournament_id,opponentTeamId).first();
      if (!opponentCheckin || !["checked_in","excused"].includes(opponentCheckin.status)) return fail("OPPONENT_NOT_CHECKED_IN", "Нельзя присудить техническую победу, пока соперник не подтвердил участие или не получил освобождение от check-in.", 409);
      const write = await db.prepare("UPDATE matches SET status='completed',score_a=?,score_b=?,winner_team_id=?,result_source='no_show_forfeit',result_verified_at=?,updated_at=? WHERE id=? AND status IN ('scheduled','in_progress')")
        .bind(scoreA,scoreB,winner,timestamp,timestamp,id).run();
      if (!write.meta?.changes) return fail("RESULT_ALREADY_SAVED","Результат матча уже сохранён другим запросом.",409);
      const after = await loadMatch(db,id);
      await db.prepare("INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,before_json,after_json) VALUES (?,?,'judge_match_forfeit','match',?,?,?)")
        .bind(await createAuditEventId(db),user.id,id,JSON.stringify(match),JSON.stringify(after)).run();
      const room = await db.prepare("SELECT * FROM match_rooms WHERE match_id=?").bind(id).first();
      try {
        const progression = await advanceWinner(db,id,winner);
        return json({ data:publicRoom(after,room,access),progression },200,{"Cache-Control":"no-store, private"});
      } catch (error) {
        console.error("MERCY MATCH forfeit progression failed:",error);
        return fail("RESULT_SAVED_PROGRESSION_PENDING","Техническое поражение сохранено, но продвижение победителя не завершилось. Повтори попытку позже.",503);
      }
    }
    if (action === "verify_result") {
      if (!access.owner && !access.organizer && !access.judge) return fail("REFEREE_REQUIRED", "Подать результат может только назначенный судья или организатор.", 403);
      if (!match.tournament_published_at || !["published", "active"].includes(match.tournament_status)) return fail("TOURNAMENT_NOT_PUBLISHED", "Результат можно подать только в опубликованном турнире.", 409);
      if (!["scheduled", "in_progress"].includes(match.status) || match.team_a_id == null || match.team_b_id == null) return fail("MATCH_NOT_PLAYABLE", "Матч не готов к внесению результата.", 409);
      const scoreA = Number(body.score_a), scoreB = Number(body.score_b);
      if (!Number.isSafeInteger(scoreA) || !Number.isSafeInteger(scoreB) || scoreA < 0 || scoreB < 0 || scoreA === scoreB)
        return fail("INVALID_RESULT", "Укажи два разных целых счёта от нуля.");
      const roomConfig = await db.prepare("SELECT series_format FROM match_rooms WHERE match_id=?").bind(id).first();
      const targetWins = ({ BO1: 1, BO3: 2, BO5: 3 })[roomConfig?.series_format || "BO1"] || 1;
      if (Math.max(scoreA, scoreB) !== targetWins || Math.min(scoreA, scoreB) >= targetWins)
        return fail("SERIES_NOT_FINISHED", "Проверь счёт серии: формат " + (roomConfig?.series_format || "BO1") + " требует ровно " + targetWins + " побед на картах.");
      const winner = scoreA > scoreB ? match.team_a_id : match.team_b_id;
      const confirmingTeam = String(winner) === String(match.team_a_id) ? match.team_b_id : match.team_a_id;
      const existing = await db.prepare("SELECT status FROM match_result_submissions WHERE match_id=?").bind(id).first();
      if (existing) return fail("RESULT_SUBMISSION_EXISTS", existing.status === "disputed" ? "Результат оспорен. Решение принимает организатор." : "По этому матчу уже есть поданный результат.", 409);
      const submittedAt = timestamp;
      const writes = await db.batch([
        db.prepare("INSERT INTO match_result_submissions (match_id,proposed_by,score_a,score_b,winner_team_id,confirming_team_id,status,submitted_at) VALUES (?,?,?,?,?,?,'pending',?)")
          .bind(id,user.id,scoreA,scoreB,winner,confirmingTeam,submittedAt),
        db.prepare("INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,before_json,after_json) VALUES (?,?,'judge_match_result_submitted','match',?,?,?)")
          .bind(await createAuditEventId(db),user.id,id,JSON.stringify({status:match.status}),JSON.stringify({score_a:scoreA,score_b:scoreB,winner_team_id:winner,confirming_team_id:confirmingTeam,status:"pending"}))
      ]);
      const captain = await db.prepare("SELECT captain_id FROM teams WHERE id=?").bind(confirmingTeam).first();
      if (captain?.captain_id) await db.prepare("INSERT INTO notifications (user_id,type,title,message,link,entity_type,entity_id) VALUES (?,?,?,?,?,'match',?)")
        .bind(captain.captain_id,"match_result_confirmation","Подтверди результат матча","Судья отправил результат матча #"+id+". Проверь счёт и подтверди его или открой спор.","/match.html?id="+encodeURIComponent(id),String(id)).run();
      const room = await db.prepare("SELECT * FROM match_rooms WHERE match_id=?").bind(id).first();
      const submission = await db.prepare("SELECT * FROM match_result_submissions WHERE match_id=?").bind(id).first();
      return json({ data: publicRoom(match,room,access,submission), submitted:true },202,{"Cache-Control":"no-store, private"});
    }
    if (action === "confirm_result" || action === "dispute_result") {
      const submission = await db.prepare("SELECT * FROM match_result_submissions WHERE match_id=?").bind(id).first();
      if (!submission || submission.status !== "pending") return fail("RESULT_NOT_PENDING","Нет результата, ожидающего подтверждения.",409);
      if (!access.canReady || !access.side) return fail("TEAM_CAPTAIN_REQUIRED","Подтвердить результат может только капитан команды-соперника.",403);
      const ownTeamId = access.side === "a" ? match.team_a_id : match.team_b_id;
      if (String(ownTeamId) !== String(submission.confirming_team_id)) return fail("OPPONENT_CONFIRMATION_REQUIRED","Подтвердить или оспорить результат может только капитан проигравшей по протоколу команды.",403);
      const disputeReason = String(body.reason || "").trim().slice(0,500);
      if (action === "dispute_result" && disputeReason.length < 5) return fail("DISPUTE_REASON_REQUIRED","Опиши причину спора минимум пятью символами.");
      const nextStatus = action === "confirm_result" ? "confirmed" : "disputed";
      const decision = await db.prepare("UPDATE match_result_submissions SET status=?,decided_by=?,decided_at=?,dispute_reason=? WHERE match_id=? AND status='pending'")
        .bind(nextStatus,user.id,timestamp,action === "dispute_result" ? disputeReason : null,id).run();
      if (!decision.meta?.changes) return fail("RESULT_DECISION_CONFLICT","Результат уже обработан другим запросом.",409);
      await audit(db,user.id,action === "confirm_result" ? "match_result_confirmed_by_opponent" : "match_result_disputed",id,{score_a:submission.score_a,score_b:submission.score_b,reason:disputeReason||null});
      if (action === "dispute_result") {
        const organizers = await db.prepare("SELECT user_id FROM tournament_staff WHERE tournament_id=? AND staff_role IN ('organizer','admin')").bind(match.tournament_id).all();
        const recipients = new Set((organizers.results||[]).map(row=>String(row.user_id)));
        recipients.add(String(match.organizer_id));
        const statements = [...recipients].filter(Boolean).map(userId=>db.prepare("INSERT INTO notifications (user_id,type,title,message,link,entity_type,entity_id) VALUES (?,?,?,?,?,'match',?)")
          .bind(userId,"match_result_disputed","Спор по результату матча","Команда оспорила результат матча #"+id+". Требуется решение организатора.","/match.html?id="+encodeURIComponent(id),String(id)));
        if(statements.length) await db.batch(statements);
      } else {
        const write = await db.prepare("UPDATE matches SET status='completed',score_a=?,score_b=?,winner_team_id=?,result_source='judge_verified',result_verified_at=?,updated_at=? WHERE id=? AND status IN ('scheduled','in_progress') AND team_a_id IS NOT NULL AND team_b_id IS NOT NULL")
          .bind(submission.score_a,submission.score_b,submission.winner_team_id,timestamp,timestamp,id).run();
        if (!write.meta?.changes) return fail("RESULT_FINALIZE_CONFLICT","Матч изменился до фиксации результата. Организатору нужно проверить его вручную.",409);
        const after = await loadMatch(db,id);
        await db.prepare("INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,before_json,after_json) VALUES (?,?,'judge_match_result_finalized','match',?,?,?)")
          .bind(await createAuditEventId(db),user.id,id,JSON.stringify(match),JSON.stringify(after)).run();
        try { await advanceWinner(db,id,submission.winner_team_id); }
        catch (error) {
          console.error("MERCY MATCH result progression failed:",error);
          return fail("RESULT_SAVED_PROGRESSION_PENDING","Результат подтверждён и сохранён. Продвижение победителя по сетке нужно повторить из кабинета организатора.",503);
        }
      }
      const updatedMatch = await loadMatch(db,id);
      const room = await db.prepare("SELECT * FROM match_rooms WHERE match_id=?").bind(id).first();
      const updatedSubmission = await db.prepare("SELECT * FROM match_result_submissions WHERE match_id=?").bind(id).first();
      return json({ data:publicRoom(updatedMatch,room,access,updatedSubmission), decision:nextStatus },200,{"Cache-Control":"no-store, private"});
    }
    if (action === "resolve_result") {
      if (!access.owner && !access.organizer) return fail("ORGANIZER_REQUIRED","Спорный результат может разрешить только организатор турнира.",403);
      const submission = await db.prepare("SELECT * FROM match_result_submissions WHERE match_id=?").bind(id).first();
      if (!submission || submission.status !== "disputed") return fail("RESULT_NOT_DISPUTED","По этому матчу нет открытого спора.",409);
      const scoreA = Number(body.score_a), scoreB = Number(body.score_b);
      if (!Number.isSafeInteger(scoreA)||!Number.isSafeInteger(scoreB)||scoreA<0||scoreB<0||scoreA===scoreB) return fail("INVALID_RESULT","Укажи корректный итоговый счёт.");
      const roomConfig = await db.prepare("SELECT series_format FROM match_rooms WHERE match_id=?").bind(id).first();
      const targetWins = ({BO1:1,BO3:2,BO5:3})[roomConfig?.series_format||"BO1"]||1;
      if (Math.max(scoreA,scoreB)!==targetWins||Math.min(scoreA,scoreB)>=targetWins) return fail("SERIES_NOT_FINISHED","Счёт не соответствует формату серии.");
      const winner = scoreA>scoreB?match.team_a_id:match.team_b_id;
      if (!["scheduled","in_progress"].includes(match.status)) return fail("MATCH_NOT_PLAYABLE","Матч уже нельзя завершить обычным решением.",409);
      const writes = await db.batch([
        db.prepare("UPDATE match_result_submissions SET status='confirmed',score_a=?,score_b=?,winner_team_id=?,decided_by=?,decided_at=?,dispute_reason=NULL WHERE match_id=? AND status='disputed'")
          .bind(scoreA,scoreB,winner,user.id,timestamp,id),
        db.prepare("UPDATE matches SET status='completed',score_a=?,score_b=?,winner_team_id=?,result_source='organizer_resolved',result_verified_at=?,updated_at=? WHERE id=? AND status IN ('scheduled','in_progress')")
          .bind(scoreA,scoreB,winner,timestamp,timestamp,id),
        db.prepare("INSERT INTO audit_events (id,actor_id,action,entity_type,entity_id,before_json,after_json) VALUES (?,?,'organizer_resolved_match_result','match',?,?,?)")
          .bind(await createAuditEventId(db),user.id,id,JSON.stringify({status:"disputed",score_a:submission.score_a,score_b:submission.score_b,reason:submission.dispute_reason}),JSON.stringify({status:"confirmed",score_a:scoreA,score_b:scoreB,winner_team_id:winner}))
      ]);
      try { await advanceWinner(db,id,winner); }
      catch (error) { console.error("MERCY MATCH organizer resolution progression failed:",error); return fail("RESULT_SAVED_PROGRESSION_PENDING","Решение сохранено. Продвижение по сетке нужно повторить.",503); }
      const updatedMatch=await loadMatch(db,id),room=await db.prepare("SELECT * FROM match_rooms WHERE match_id=?").bind(id).first(),updatedSubmission=await db.prepare("SELECT * FROM match_result_submissions WHERE match_id=?").bind(id).first();
      return json({data:publicRoom(updatedMatch,room,access,updatedSubmission),decision:"confirmed",resolved_by_organizer:true},200,{"Cache-Control":"no-store, private"});
    }
    return fail("UNKNOWN_ACTION", "Неизвестное действие.");
  } catch (error) {
    console.error("MERCY MATCH room write failed:", error);
    return fail("MATCH_ROOM_WRITE_FAILED", "Не удалось сохранить данные игровой комнаты.", 500);
  }
}
