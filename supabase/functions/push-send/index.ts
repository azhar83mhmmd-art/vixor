// Pengirim Web Push ORVIX. Dipanggil HANYA oleh trigger database (pg_net) dengan header x-push-secret; bukan dari browser.
// Memakai service role (otomatis tersedia di Edge Function) untuk membaca penerima + langganan. Deploy:
//   supabase functions deploy push-send --no-verify-jwt
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:...), PUSH_WEBHOOK_SECRET.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";
import { buildCall, buildFriend, buildMessage, buildTest, isGone, Kind, Payload, WEBPUSH, wants } from "../_shared/pushpayload.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
// VAPID_SUBJECT wajib berawalan mailto: atau https:// — bila user mengisi email polos, otomatis dibetulkan agar fungsi tidak crash saat boot.
const rawSubject = (Deno.env.get("VAPID_SUBJECT") ?? "").trim();
const subject = /^(mailto:|https:\/\/)/i.test(rawSubject) ? rawSubject : "mailto:" + (rawSubject || "admin@orvix.app");
webpush.setVapidDetails(subject, (Deno.env.get("VAPID_PUBLIC_KEY") ?? "").trim(), (Deno.env.get("VAPID_PRIVATE_KEY") ?? "").trim());
const SECRET = (Deno.env.get("PUSH_WEBHOOK_SECRET") ?? "").trim();
const ok = (b: unknown = { ok: true }) => new Response(JSON.stringify(b), { headers: { "Content-Type": "application/json" } });

const eq = (a: string, b: string) => { if (a.length !== b.length || !a.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

type Target = { user_id: string; payload: Payload; opt: { TTL: number; urgency: string } };

// penerima yang tidak memblokir / diblokir pengirim, tidak ditangguhkan
async function eligible(ids: string[], sender: string | null): Promise<string[]> {
  if (!ids.length) return [];
  const { data: ps } = await db.from("profiles").select("id,is_suspended").in("id", ids);
  let ok = (ps ?? []).filter((p) => !p.is_suspended).map((p) => p.id as string);
  if (sender && ok.length) {
    const { data: bl } = await db.from("blocked_users").select("blocker_id,blocked_id")
      .or(`and(blocker_id.eq.${sender},blocked_id.in.(${ok.join(",")})),and(blocked_id.eq.${sender},blocker_id.in.(${ok.join(",")}))`);
    const bad = new Set((bl ?? []).flatMap((r) => [r.blocker_id, r.blocked_id]));
    ok = ok.filter((u) => !bad.has(u));
  }
  return ok;
}
async function prefsFor(ids: string[]) {
  const { data } = await db.from("push_prefs").select("user_id,prefs").in("user_id", ids);
  return new Map((data ?? []).map((r) => [r.user_id as string, r.prefs as Record<string, boolean>]));
}
async function name(id: string | null): Promise<string> {
  if (!id) return "Seseorang";
  const { data } = await db.from("profiles").select("display_name,username").eq("id", id).maybeSingle();
  return data?.display_name || data?.username || "Seseorang";
}

async function plan(ev: Record<string, unknown>): Promise<Target[]> {
  const type = String(ev.type);
  if (type === "message") {
    const { data: m } = await db.from("messages").select("id,conversation_id,sender_id,content,message_type,media_type,deleted_at,expires_at").eq("id", String(ev.id)).maybeSingle();
    if (!m || m.deleted_at || m.message_type === "system" || (m.expires_at && new Date(m.expires_at) < new Date())) return [];
    const [{ data: cv }, { data: mem }] = await Promise.all([
      db.from("conversations").select("type,title").eq("id", m.conversation_id).maybeSingle(),
      db.from("conversation_members").select("user_id").eq("conversation_id", m.conversation_id),
    ]);
    if (!cv) return [];
    const isGroup = cv.type === "group";
    const ids = await eligible((mem ?? []).map((r) => r.user_id as string).filter((u) => u !== m.sender_id), m.sender_id);   // tidak pernah ke pengirim
    const prefs = await prefsFor(ids), sender = await name(m.sender_id), kind: Kind = isGroup ? "group" : "message";
    return ids.filter((u) => wants(prefs.get(u), kind)).map((u) => ({
      user_id: u, opt: WEBPUSH.message,
      payload: buildMessage({ senderName: sender, isGroup, groupTitle: cv.title, convId: m.conversation_id, m, preview: prefs.get(u)?.preview !== false }),
    }));
  }
  if (type === "friend") {
    const { data: f } = await db.from("friendships").select("requester_id,addressee_id,status").eq("id", String(ev.id)).maybeSingle();
    if (!f || f.status !== "pending") return [];
    const ids = await eligible([f.addressee_id], f.requester_id), prefs = await prefsFor(ids), n = await name(f.requester_id);
    return ids.filter((u) => wants(prefs.get(u), "friend")).map((u) => ({ user_id: u, opt: WEBPUSH.friend, payload: buildFriend(n) }));
  }
  if (type === "call") {
    const [{ data: c }, { data: p }] = await Promise.all([
      db.from("calls").select("id,conversation_id,kind,scope,created_by,status,created_at").eq("id", String(ev.call_id)).maybeSingle(),
      db.from("call_participants").select("state").eq("call_id", String(ev.call_id)).eq("user_id", String(ev.user_id)).maybeSingle(),
    ]);
    // hanya panggilan yang masih berdering dan belum basi; selebihnya tidak ada gunanya diberitahukan
    if (!c || c.status !== "ringing" || p?.state !== "invited" || c.created_by === ev.user_id || Date.now() - new Date(c.created_at).getTime() > 40000) return [];
    const ids = await eligible([String(ev.user_id)], c.created_by), prefs = await prefsFor(ids);
    if (!ids.length || !wants(prefs.get(ids[0]), "call")) return [];
    const { data: cv } = await db.from("conversations").select("title").eq("id", c.conversation_id).maybeSingle();
    return [{ user_id: ids[0], opt: WEBPUSH.call, payload: buildCall({ name: await name(c.created_by), kind: c.kind, isGroup: c.scope === "group", groupTitle: cv?.title, callId: c.id, convId: c.conversation_id }) }];
  }
  if (type === "test") return [{ user_id: String(ev.user_id), opt: WEBPUSH.test, payload: buildTest() }];
  return [];
}

async function deliver(targets: Target[]) {
  if (!targets.length) return { sent: 0, removed: 0, failed: 0 };
  const { data: subs } = await db.from("push_subscriptions").select("id,user_id,endpoint,p256dh,auth").in("user_id", [...new Set(targets.map((t) => t.user_id))]);
  const byUser = new Map<string, Target>(targets.map((t) => [t.user_id, t]));
  let sent = 0, removed = 0, failed = 0; const list = subs ?? [];
  for (let i = 0; i < list.length; i += 20) {
    await Promise.all(list.slice(i, i + 20).map(async (s) => {
      const t = byUser.get(s.user_id as string); if (!t) return;
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(t.payload), { TTL: t.opt.TTL, urgency: t.opt.urgency as "high" | "normal" });
        sent++; await db.from("push_subscriptions").update({ last_ok_at: new Date().toISOString(), failures: 0 }).eq("id", s.id);
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode ?? 0;
        if (isGone(code)) { removed++; await db.from("push_subscriptions").delete().eq("id", s.id); }          // langganan kedaluwarsa: bersihkan
        else { failed++; console.error("[push-send] gagal kirim", code, (e as Error).message); const { data: r } = await db.from("push_subscriptions").select("failures").eq("id", s.id).maybeSingle(); const n = (r?.failures ?? 0) + 1;
          if (n >= 8) await db.from("push_subscriptions").delete().eq("id", s.id); else await db.from("push_subscriptions").update({ failures: n }).eq("id", s.id); }
      }
    }));
  }
  return { sent, removed, failed };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  if (!eq(req.headers.get("x-push-secret") ?? "", SECRET)) return new Response("Unauthorized", { status: 401 });
  try { const ev = await req.json(); return ok(await deliver(await plan(ev))); }
  catch (e) { console.error("[push-send]", e); return ok({ ok: false });   // 200 agar pg_net tidak mengulang; galat ada di log fungsi
  }
});
