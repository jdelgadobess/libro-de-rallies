// Gives someone access: creates their account (email + password) if needed and sets their permission.
// Only the site administrator can call it. No emails are sent.
import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const ROLES = new Set(["admin", "editor", "viewer"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "Usa POST." });

  const caller = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: role } = await caller.rpc("my_role");
  if (role !== "admin") return reply(403, { error: "Solo el administrador puede dar acceso." });

  let body: { email?: string; role?: string; password?: string } = {};
  try { body = await req.json(); } catch { /* handled below */ }
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply(400, { error: "El correo no es válido." });
  if (!ROLES.has(String(body.role))) return reply(400, { error: "Permiso no válido." });
  if (password && password.length < 8) return reply(400, { error: "La contraseña tiene que tener al menos 8 caracteres." });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // find the account, if it already exists
  let userId: string | null = null;
  for (let page = 1; !userId; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) { console.error(error); return reply(500, { error: "No se pudo consultar las cuentas." }); }
    userId = data.users.find((u) => (u.email ?? "").toLowerCase() === email)?.id ?? null;
    if (data.users.length < 1000) break;
  }

  let created = false;
  if (!userId) {
    if (!password) return reply(400, { error: "Esta persona aún no tiene cuenta: invéntale una contraseña." });
    const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) { console.error(error); return reply(400, { error: "No se pudo crear la cuenta (" + error.message + ")." }); }
    created = true;
  } else if (password) {
    const { error } = await admin.auth.admin.updateUserById(userId, { password, email_confirm: true });
    if (error) { console.error(error); return reply(400, { error: "No se pudo cambiar la contraseña (" + error.message + ")." }); }
  }

  const { error } = await admin.from("members").upsert({ email, role: body.role });
  if (error) { console.error(error); return reply(500, { error: "No se pudo guardar el permiso." }); }
  return reply(200, { ok: true, created });
});
