// Edge Function admin ORVIX — semua operasi sensitif divalidasi ulang di server.
// Secrets otomatis tersedia: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Opsional: ALLOWED_ORIGIN.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { corsHeaders, json } from "../_shared/cors.ts";
import { purgeUserFiles } from "../_shared/purge.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROFILE_COLS = "id,orvix_id,username,display_name,avatar_url,status_text,is_verified,verified_at,is_suspended,role,created_at,last_seen_at,is_creator,is_business,is_official,premium_until";

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
// deno-lint-ignore no-explicit-any
type Body = Record<string, any>;

const uid = (v: unknown): string => { if (typeof v !== "string" || !UUID.test(v)) throw new HttpError(400, "ID pengguna tidak valid"); return v; };
const page = (v: unknown) => Math.max(0, Math.min(10000, Number.isInteger(v) ? (v as number) : 0));
const count = async (table: string, f?: (q: any) => any) => { // deno-lint-ignore no-explicit-any
  let q = admin.from(table).select("*", { count: "exact", head: true }); if (f) q = f(q);
  const { count: c, error } = await q; if (error) throw error; return c ?? 0;
};
async function audit(adminId: string, action: string, target: string | null, details: Body = {}) {
  const { error } = await admin.from("admin_audit_logs").insert({ admin_id: adminId, action, target_user_id: target, details });
  if (error) console.error("audit gagal", error.message);
}
async function target(id: string) {
  const { data, error } = await admin.from("profiles").select(PROFILE_COLS).eq("id", id).maybeSingle();
  if (error) throw error; if (!data) throw new HttpError(404, "Pengguna tidak ditemukan"); return data;
}
const adminCount = () => count("profiles", (q) => q.eq("role", "admin").eq("is_suspended", false));

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { error: "Metode tidak diizinkan" }, cors);
  try {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) throw new HttpError(401, "Belum login");
    const { data: au, error: ae } = await admin.auth.getUser(token);
    if (ae || !au.user) throw new HttpError(401, "Sesi tidak valid");
    const { data: me } = await admin.from("profiles").select("id,role,is_suspended").eq("id", au.user.id).maybeSingle();
    if (!me || me.role !== "admin" || me.is_suspended) throw new HttpError(403, "Akses ditolak");   // role dari database, bukan dari browser

    const b: Body = (await req.json().catch(() => null)) ?? {};
    switch (b.action) {
      case "stats": {
        const since = new Date(Date.now() - 86400000).toISOString();
        const [users, verified, suspended, active, conversations, messages, reports] = await Promise.all([
          count("profiles"), count("profiles", (q) => q.eq("is_verified", true)), count("profiles", (q) => q.eq("is_suspended", true)),
          count("profiles", (q) => q.gte("last_seen_at", since)), count("conversations"), count("messages"),
          count("reports", (q) => q.in("status", ["open", "reviewing"])),
        ]);
        return json(200, { users, verified, suspended, active24h: active, conversations, messages, openReports: reports }, cors);
      }
      case "list_users": {
        const size = Math.min(50, Math.max(5, Number.isInteger(b.pageSize) ? b.pageSize : 20)), p = page(b.page);
        let q = admin.from("profiles").select(PROFILE_COLS, { count: "exact" }).order("created_at", { ascending: false }).range(p * size, p * size + size - 1);
        const s = String(b.q ?? "").replace(/[^\p{L}\p{N}_ ]/gu, "").trim().slice(0, 40);
        if (s) q = q.or(`username.ilike.%${s}%,display_name.ilike.%${s}%,orvix_id.ilike.%${s}%`);
        const f = b.filter;
        if (f === "verified") q = q.eq("is_verified", true); else if (f === "unverified") q = q.eq("is_verified", false);
        else if (f === "active") q = q.eq("is_suspended", false); else if (f === "suspended") q = q.eq("is_suspended", true);
        const { data, count: total, error } = await q; if (error) throw error;
        return json(200, { users: data, total: total ?? 0, page: p, pageSize: size }, cors);
      }
      case "get_user": {
        const t = await target(uid(b.user_id));
        const { data: u } = await admin.auth.admin.getUserById(t.id);
        const reportsAgainst = await count("reports", (q) => q.eq("reported_user_id", t.id));
        return json(200, { user: t, email: u?.user?.email ?? null, email_confirmed: !!u?.user?.email_confirmed_at, last_sign_in_at: u?.user?.last_sign_in_at ?? null, reports_against: reportsAgainst }, cors);
      }
      case "set_verified": {
        const t = await target(uid(b.user_id)); if (typeof b.value !== "boolean") throw new HttpError(400, "Nilai tidak valid");
        const note = typeof b.note === "string" ? b.note.trim().slice(0, 200) : "";
        const { error } = await admin.from("profiles").update({ is_verified: b.value, verified_at: b.value ? new Date().toISOString() : null }).eq("id", t.id);
        if (error) throw error; await audit(me.id, b.value ? "verify" : "unverify", t.id, { username: t.username, note });
        return json(200, { ok: true }, cors);
      }
      case "set_suspended": {
        const t = await target(uid(b.user_id)); if (typeof b.value !== "boolean") throw new HttpError(400, "Nilai tidak valid");
        if (t.id === me.id) throw new HttpError(400, "Tidak bisa menonaktifkan akun sendiri");
        if (t.role === "admin") throw new HttpError(400, "Admin tidak bisa dinonaktifkan dari panel ini");
        const { error } = await admin.from("profiles").update({ is_suspended: b.value }).eq("id", t.id); if (error) throw error;
        const { error: be } = await admin.auth.admin.updateUserById(t.id, { ban_duration: b.value ? "876000h" : "none" }); if (be) throw be;
        await audit(me.id, b.value ? "suspend" : "unsuspend", t.id, { username: t.username });
        return json(200, { ok: true }, cors);
      }
      case "delete_user": {
        const t = await target(uid(b.user_id));
        if (t.id === me.id) throw new HttpError(400, "Tidak bisa menghapus akun sendiri dari panel admin");
        if (String(b.confirm_username ?? "") !== t.username) throw new HttpError(400, "Konfirmasi username tidak cocok");
        if (t.role === "admin" && (await adminCount()) <= 1) throw new HttpError(400, "Tidak bisa menghapus admin terakhir");
        await audit(me.id, "delete_user", t.id, { username: t.username, orvix_id: t.orvix_id });
        await purgeUserFiles(admin, t.id);
        const { error } = await admin.auth.admin.deleteUser(t.id); if (error) throw error;   // cascade ke profiles & data terkait
        return json(200, { ok: true }, cors);
      }
      case "list_reports": {
        const p = page(b.page), st = ["open", "reviewing", "resolved", "dismissed"].includes(b.status) ? b.status : null;
        let q = admin.from("reports").select("*", { count: "exact" }).order("created_at", { ascending: false }).range(p * 20, p * 20 + 19);
        if (st) q = q.eq("status", st);
        const { data, count: total, error } = await q; if (error) throw error;
        const ids = [...new Set((data ?? []).flatMap((r) => [r.reporter_id, r.reported_user_id]))];
        const { data: ps } = ids.length ? await admin.from("profiles").select("id,username,display_name,orvix_id").in("id", ids) : { data: [] };
        const m = new Map((ps ?? []).map((x) => [x.id, x]));
        return json(200, { reports: (data ?? []).map((r) => ({ ...r, reporter: m.get(r.reporter_id) ?? null, reported: m.get(r.reported_user_id) ?? null })), total: total ?? 0 }, cors);
      }
      case "review_report": {
        if (typeof b.id !== "string" || !UUID.test(b.id)) throw new HttpError(400, "ID laporan tidak valid");
        if (!["reviewing", "resolved", "dismissed"].includes(b.status)) throw new HttpError(400, "Status tidak valid");
        const { data: r, error } = await admin.from("reports").update({ status: b.status, reviewed_at: new Date().toISOString(), reviewed_by: me.id }).eq("id", b.id).select("reported_user_id").maybeSingle();
        if (error) throw error; if (!r) throw new HttpError(404, "Laporan tidak ditemukan");
        await audit(me.id, "review_report", r.reported_user_id, { report_id: b.id, status: b.status });
        return json(200, { ok: true }, cors);
      }
      case "list_audit": {
        const p = page(b.page);
        const { data, count: total, error } = await admin.from("admin_audit_logs").select("*", { count: "exact" }).order("created_at", { ascending: false }).range(p * 30, p * 30 + 29);
        if (error) throw error;
        const ids = [...new Set((data ?? []).map((l) => l.admin_id).filter(Boolean))];
        const { data: ps } = ids.length ? await admin.from("profiles").select("id,username").in("id", ids) : { data: [] };
        const m = new Map((ps ?? []).map((x) => [x.id, x.username]));
        return json(200, { logs: (data ?? []).map((l) => ({ ...l, admin_username: m.get(l.admin_id) ?? null })), total: total ?? 0 }, cors);
      }
      default: throw new HttpError(400, "Aksi tidak dikenal");
    }
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message }, cors);
    console.error(e); return json(500, { error: "Terjadi kesalahan server" }, cors);
  }
});
