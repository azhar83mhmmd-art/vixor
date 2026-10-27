// Penghapusan akun milik sendiri lewat backend tepercaya (butuh service role untuk auth.admin.deleteUser).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders, json } from "../_shared/cors.ts";
import { purgeUserFiles } from "../_shared/purge.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { error: "Metode tidak diizinkan" }, cors);
  try {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: au, error: ae } = await admin.auth.getUser(token);
    if (ae || !au.user) return json(401, { error: "Sesi tidak valid" }, cors);
    const body = await req.json().catch(() => ({}));
    const { data: me } = await admin.from("profiles").select("id,username,role").eq("id", au.user.id).maybeSingle();
    if (!me) return json(404, { error: "Profil tidak ditemukan" }, cors);
    if (String(body?.confirm_username ?? "") !== me.username) return json(400, { error: "Konfirmasi username tidak cocok" }, cors);
    if (me.role === "admin") {
      const { count } = await admin.from("profiles").select("*", { count: "exact", head: true }).eq("role", "admin").eq("is_suspended", false);
      if ((count ?? 0) <= 1) return json(400, { error: "Kamu admin terakhir. Tetapkan admin lain sebelum menghapus akun." }, cors);
    }
    await admin.from("admin_audit_logs").insert({ admin_id: null, action: "self_delete", target_user_id: me.id, details: { username: me.username } });
    await purgeUserFiles(admin, me.id);
    const { error } = await admin.auth.admin.deleteUser(me.id);
    if (error) throw error;
    return json(200, { ok: true }, cors);
  } catch (e) {
    console.error(e); return json(500, { error: "Terjadi kesalahan server" }, cors);
  }
});
