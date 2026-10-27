// Pendaftaran tanpa konfirmasi email: akun dibuat langsung aktif (email_confirm: true), tidak ada email yang dikirim.
// Deploy: supabase functions deploy register --no-verify-jwt
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders, json } from "../_shared/cors.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const USERNAME = /^[a-z0-9_]{3,20}$/;

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { error: "Metode tidak diizinkan" }, cors);
  try {
    const b = await req.json().catch(() => ({}));
    const email = String(b?.email ?? "").trim().toLowerCase();
    const password = String(b?.password ?? "");
    const username = String(b?.username ?? "").trim().toLowerCase();
    const display_name = String(b?.display_name ?? "").trim();
    if (!EMAIL.test(email) || email.length > 254) return json(400, { error: "Masukkan email yang valid." }, cors);
    if (!USERNAME.test(username)) return json(400, { error: "Username 3-20 karakter: huruf kecil, angka, garis bawah." }, cors);
    if (!display_name || display_name.length > 40) return json(400, { error: "Nama tampilan 1-40 karakter." }, cors);
    if (password.length < 8 || password.length > 72) return json(400, { error: "Password 8-72 karakter." }, cors);
    const { data: taken } = await admin.from("profiles").select("id").eq("username", username).maybeSingle();
    if (taken) return json(409, { error: "Username sudah dipakai." }, cors);
    const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { username, display_name } });
    if (error) {
      if (/already|registered|exists/i.test(error.message)) return json(409, { error: "Email sudah terdaftar. Silakan masuk." }, cors);
      if (/password/i.test(error.message)) return json(400, { error: error.message }, cors);
      throw error;
    }
    return json(200, { ok: true }, cors);
  } catch (e) {
    console.error(e); return json(500, { error: "Terjadi kesalahan server" }, cors);
  }
});
