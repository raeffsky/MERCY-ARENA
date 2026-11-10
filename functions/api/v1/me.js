import { json } from "./_lib/http.js";
import { getSessionUser, isOwnerAccount } from "./_lib/session-auth.js";

export async function onRequestGet({ request, env }) {
  const result = await getSessionUser(request, env);
  if (result.error) return result.error;
  if (!result.user) return json({ authenticated: false, account: null, roles: [], access: "guest" });
  const user = result.user;
  const assignedOrganizer = await env.DB.prepare("SELECT 1 FROM tournament_staff WHERE user_id=? AND staff_role IN ('organizer','admin') LIMIT 1").bind(user.id).first().catch(() => null);
  const assignedReferee = await env.DB.prepare("SELECT 1 FROM tournament_staff WHERE user_id=? AND staff_role='referee' LIMIT 1").bind(user.id).first().catch(() => null);
  const hasOrganizerAccess = user.roles.includes("organizer") || !!assignedOrganizer;
  const profile = await env.DB.prepare("SELECT id,nickname,game_id,server_id,mlbb_verified_at,role,team_id,region,avatar_url,profile_status FROM players WHERE user_id=?").bind(user.id).first();
  let unreadCount = 0;
  try {
    const unread = await env.DB.prepare("SELECT COUNT(*) AS total FROM notifications WHERE user_id=? AND read_at IS NULL").bind(user.id).first();
    unreadCount = unread?.total || 0;
  } catch (error) {
    if (!/no such table:\s*notifications/i.test(String(error?.message || error))) throw error;
    console.warn("Unread notification count is unavailable until migration 0013 is applied.");
  }
  return json({
    authenticated: true,
    account: { id: user.id, email: user.email, name: user.display_name },
    roles: user.roles,
    is_owner: isOwnerAccount(user, env),
    has_organizer_access: hasOrganizerAccess,
    has_referee_access: !!assignedReferee,
    access: user.roles.includes("administrator") ? "administrator" : hasOrganizerAccess ? "organizer" : "user",
    profile: profile || null,
    notifications: { unread_count: unreadCount }
  });
}
