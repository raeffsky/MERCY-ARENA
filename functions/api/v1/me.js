import { json } from "./_lib/http.js";
import { getSessionUser } from "./_lib/session-auth.js";

export async function onRequestGet({ request, env }) {
  const result = await getSessionUser(request, env);
  if (result.error) return result.error;
  if (!result.user) return json({ authenticated: false, account: null, roles: [], access: "guest" });
  const user = result.user;
  return json({
    authenticated: true,
    account: { id: user.id, email: user.email, name: user.display_name },
    roles: user.roles,
    access: user.roles.includes("administrator") ? "administrator" : user.roles.includes("organizer") ? "organizer" : "user"
  });
}
