import { json } from "./_lib/http.js";
import { getSessionUser } from "./_lib/session-auth.js";

export async function onRequestGet({ request, env }) {
  const result = await getSessionUser(request, env);
  if (result.error) return result.error;
  if (!result.user) return json({ authenticated: false, account: null, roles: [], access: "guest" });
  const user = result.user;
  const profile = await env.DB.prepare("SELECT id,nickname,game_id,server_id,mlbb_verified_at,role,team_id,region,avatar_url,profile_status FROM players WHERE user_id=?").bind(user.id).first();
  return json({
    authenticated: true,
    account: { id: user.id, email: user.email, name: user.display_name },
    roles: user.roles,
    access: user.roles.includes("administrator") ? "administrator" : user.roles.includes("organizer") ? "organizer" : "user",
    profile: profile || null
  });
}
