import { json } from "./_lib/http.js";
import { requireAccessIdentity, loadOrBootstrapUser } from "./_lib/access-auth.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ error: { code: "DATABASE_NOT_CONFIGURED", message: "База данных не подключена." } }, 503);
  const auth = await requireAccessIdentity(request, env);
  if (auth.error) return auth.error;
  const user = await loadOrBootstrapUser(env.DB, auth.identity, env);
  if (!user) return json({ authenticated: true, account: { email: auth.identity.email, name: auth.identity.name }, roles: [], access: "no_role" });
  return json({ authenticated: true, account: { id: user.id, email: user.email, name: user.display_name }, roles: user.roles, access: user.roles.includes("administrator") ? "administrator" : "user" });
}
