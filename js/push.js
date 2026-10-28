// Web Push: aktivasi/penonaktifan langganan, sinkronisasi, preferensi. Langganan disimpan lewat RPC (RLS: hanya milik sendiri).
// Status "aktif" hanya dikembalikan bila langganan browser ADA dan server mengonfirmasinya.
import { sb, errMsg } from './supabase.js';
import { VAPID_PUBLIC_KEY } from './config.js';
import { isStandalone, isIOS, registerSW } from './pwa.js';

const LS = 'orvix_push';
const u8 = (b64) => { const p = '='.repeat((4 - (b64.length % 4)) % 4), s = atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };
const same = (a, b) => { if (!a || !b) return false; const x = new Uint8Array(a), y = new Uint8Array(b); return x.length === y.length && x.every((v, i) => v === y[i]); };
export const pushSupported = () => isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const pushConfigured = () => !!VAPID_PUBLIC_KEY;
export const pushActiveLocal = (uid) => { try { return !!uid && localStorage.getItem(LS) === uid; } catch { return false; } };
const setLocal = (uid) => { try { uid ? localStorage.setItem(LS, uid) : localStorage.removeItem(LS); } catch { /* abaikan */ } };
export const PUSH_ERR = {
  unsupported: 'Browser ini tidak mendukung notifikasi push.', noconfig: 'Notifikasi push belum dikonfigurasi di server (kunci VAPID belum diisi).',
  denied: 'Izin notifikasi ditolak. Aktifkan kembali lewat pengaturan situs di browser, lalu coba lagi.', dismissed: 'Izin notifikasi tidak diberikan.',
  sw: 'Service worker tidak bisa dijalankan. Pastikan ORVIX dibuka lewat HTTPS.', subscribe: 'Gagal membuat langganan notifikasi. Periksa koneksi internet lalu coba lagi.',
  server: 'Langganan dibuat di perangkat tetapi gagal disimpan di server.', nosql: 'Fitur notifikasi belum aktif di database. Jalankan sql-parts/15a-push.sql.',
};
const fail = (code, extra) => Object.assign(new Error(PUSH_ERR[code] + (extra ? ' (' + extra + ')' : '')), { code });
async function reg() { let r = await navigator.serviceWorker.getRegistration('/'); if (!r) r = await registerSW(); if (!r) throw fail('sw'); await navigator.serviceWorker.ready; return r; }
async function save(sub) {
  const j = sub.toJSON(); if (!j.endpoint || !j.keys || !j.keys.p256dh || !j.keys.auth) throw fail('subscribe', 'kunci langganan tidak lengkap');
  const { error } = await sb.rpc('push_subscribe', { p_ep: j.endpoint, p_key: j.keys.p256dh, p_auth: j.keys.auth, p_ua: (navigator.userAgent || '').slice(0, 200) });
  if (error) throw /could not find the function|schema cache|42883|42P01/i.test(errMsg(error)) ? fail('nosql') : fail('server', errMsg(error));
}

export async function pushStatus(uid) {
  const s = { supported: pushSupported(), configured: pushConfigured(), permission: 'Notification' in window ? Notification.permission : 'denied', subscribed: false, iosNeedsInstall: isIOS() && !isStandalone() && !pushSupported() };
  if (!s.supported || !s.configured || s.permission !== 'granted') return s;
  try {
    const r = await navigator.serviceWorker.getRegistration('/'); const sub = r && (await r.pushManager.getSubscription());
    if (sub && pushActiveLocal(uid)) { const { data } = await sb.rpc('push_has', { ep: sub.endpoint }); s.subscribed = data === true; }
  } catch { /* dianggap belum aktif */ }
  return s;
}

// Dipanggil dari klik pengguna (izin hanya diminta setelah tindakan jelas).
export async function enablePush(uid) {
  if (!pushSupported()) throw fail('unsupported'); if (!pushConfigured()) throw fail('noconfig');
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm === 'denied') throw fail('denied'); if (perm !== 'granted') throw fail('dismissed');
  const r = await reg(); let sub = await r.pushManager.getSubscription(), created = false;
  const key = u8(VAPID_PUBLIC_KEY);
  if (sub && !same(sub.options && sub.options.applicationServerKey, key)) { await sub.unsubscribe().catch(() => {}); sub = null; }   // kunci VAPID berganti
  if (!sub) { try { sub = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }); created = true; } catch (e) { throw fail('subscribe', e && e.name); } }
  try { await save(sub); } catch (e) { if (created) await sub.unsubscribe().catch(() => {}); throw e; }
  setLocal(uid); return true;
}
export async function disablePush(uid) {
  try { const r = await navigator.serviceWorker.getRegistration('/'); const sub = r && (await r.pushManager.getSubscription()); if (sub) { await sb.rpc('push_unsubscribe', { ep: sub.endpoint }).catch(() => {}); await sub.unsubscribe().catch(() => {}); } } catch { /* abaikan */ }
  setLocal(null); try { localStorage.setItem('orvix_notif', '0'); } catch { /* abaikan */ }
}
// Saat logout: lepas perangkat ini dari akun agar akun berikutnya di perangkat yang sama tidak menerima notifikasi akun lama.
export async function detachForLogout() {
  if (!pushSupported()) return setLocal(null);
  try { const r = await navigator.serviceWorker.getRegistration('/'); const sub = r && (await r.pushManager.getSubscription()); if (sub) { await Promise.race([sb.rpc('push_unsubscribe', { ep: sub.endpoint }), new Promise((x) => setTimeout(x, 2500))]); await sub.unsubscribe().catch(() => {}); } } catch { /* abaikan */ }
  setLocal(null);
}
// Dipanggil setiap aplikasi dibuka: memulihkan langganan yang kedaluwarsa/diganti browser dan mendeteksi izin yang dicabut.
export async function syncPush(uid, force = false) {
  if (!pushActiveLocal(uid) || !pushSupported() || !pushConfigured()) return;
  if (Notification.permission !== 'granted') { await disablePush(uid); return; }
  const K = 'orvix_push_sync'; try { if (!force && Date.now() - +localStorage.getItem(K) < 6 * 3600 * 1000) return; } catch { /* abaikan */ }
  try {
    const r = await reg(); let sub = await r.pushManager.getSubscription(); const key = u8(VAPID_PUBLIC_KEY);
    if (sub && !same(sub.options && sub.options.applicationServerKey, key)) { await sub.unsubscribe().catch(() => {}); sub = null; }
    if (!sub) sub = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await save(sub); localStorage.setItem(K, String(Date.now()));
  } catch (e) { console.warn('[push] sinkronisasi gagal', e); }
}
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'push-resync') { sb.auth.getSession().then(({ data }) => data.session && syncPush(data.session.user.id, true)); } });

export const DEFAULT_PREFS = { messages: true, groups: true, friends: true, calls: true, preview: true };
export async function getPrefs() { const { data, error } = await sb.rpc('push_get_prefs'); if (error) throw error; return { ...DEFAULT_PREFS, ...(data || {}) }; }
export async function setPrefs(p) { const { error } = await sb.rpc('push_set_prefs', { p }); if (error) throw error; }
export async function sendTest() { const { error } = await sb.rpc('push_test'); if (error) throw error; }

/* ---------- Diagnosa end-to-end ----------
   Menjalankan semua mata rantai notifikasi dan melaporkan yang putus, lengkap dengan cara memperbaikinya.
   Tiap langkah: { id, ok: true|false|null(peringatan), title, detail, fix } */
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function health() {
  const url = `${SUPABASE_URL}/functions/v1/push-send`;
  try {
    const r = await fetch(url, { cache: 'no-store' });   // GET sederhana: tanpa preflight, fungsi memang tanpa JWT
    if (r.status === 401 || r.status === 403) return { gateway: r.status };
    if (r.status === 404) return { missing: true };
    return { ...(await r.json()), status: r.status };
  } catch (e) {
    // Bedakan "CORS memblokir" dari "tidak ada koneksi": no-cors tetap berhasil bila server terjangkau.
    try { await fetch(url, { mode: 'no-cors', cache: 'no-store' }); return { cors: true, origin: location.origin }; }
    catch { return { net: String((e && e.message) || e) }; }
  }
}
export async function diagnose(uid, onStep = () => {}, { sendTestPush = true } = {}) {
  const out = []; const add = (s) => { out.push(s); onStep(s, out); return s; };
  // 1) browser
  add({ id: 'browser', ok: pushSupported(), title: 'Browser mendukung push', detail: pushSupported() ? 'Service worker, Push API, dan Notification tersedia.' : 'Browser/konteks ini tidak mendukung push (butuh HTTPS; di iPhone/iPad ORVIX harus dipasang ke Layar Utama).', fix: 'Buka ORVIX lewat HTTPS di Chrome/Edge/Firefox/Safari terbaru.' });
  if (!pushSupported()) return out;
  add({ id: 'config', ok: pushConfigured(), title: 'Kunci VAPID publik di js/config.js', detail: pushConfigured() ? 'Terisi.' : 'VAPID_PUBLIC_KEY kosong.', fix: 'Jalankan node scripts/gen-vapid.mjs dan tempel VAPID_PUBLIC_KEY ke js/config.js.' });
  const perm = Notification.permission;
  add({ id: 'perm', ok: perm === 'granted', title: 'Izin notifikasi browser', detail: perm === 'granted' ? 'Diizinkan.' : perm === 'denied' ? 'Diblokir di browser.' : 'Belum diberikan. Aktifkan sakelar Notifikasi dulu.', fix: 'Ikon gembok di address bar, Izin situs, Notifikasi, Izinkan. Lalu muat ulang.' });
  // 2) service worker
  let reg = null; try { reg = await navigator.serviceWorker.getRegistration('/'); } catch { /* abaikan */ }
  const swUrl = reg && ((reg.active || reg.waiting || reg.installing) || {}).scriptURL;
  add({ id: 'sw', ok: !!(reg && reg.active), title: 'Service worker aktif', detail: reg && reg.active ? 'Aktif (' + new URL(swUrl).pathname + ').' : 'Belum terdaftar/aktif.', fix: 'Muat ulang halaman. Pastikan /sw.js dapat dibuka dan vercel.json ikut ter-deploy.' });
  // 3) langganan di perangkat
  let sub = null; try { sub = reg && (await reg.pushManager.getSubscription()); } catch { /* abaikan */ }
  let keyOk = null; if (sub && pushConfigured()) keyOk = same(sub.options && sub.options.applicationServerKey, u8(VAPID_PUBLIC_KEY));
  add({ id: 'sub', ok: !!sub && keyOk !== false, title: 'Langganan push di perangkat ini', detail: !sub ? 'Belum ada langganan. Aktifkan sakelar Notifikasi.' : keyOk === false ? 'Langganan dibuat dengan kunci VAPID lain.' : 'Ada.', fix: 'Matikan lalu nyalakan lagi sakelar Notifikasi untuk membuat langganan baru.' });
  // 4) Edge Function
  const h = await health();
  if (h.gateway) add({ id: 'fn', ok: false, title: 'Edge Function push-send', detail: `Gateway menolak (HTTP ${h.gateway}). Verifikasi JWT masih aktif.`, fix: 'Deploy ulang: supabase functions deploy push-send --no-verify-jwt (file supabase/config.toml sudah menyetel ini).' });
  else if (h.missing) add({ id: 'fn', ok: false, title: 'Edge Function push-send', detail: 'Tidak ditemukan (404): belum di-deploy.', fix: 'supabase functions deploy push-send --no-verify-jwt' });
  else if (h.cors) add({ id: 'fn', ok: null, title: 'Edge Function push-send', detail: 'Fungsi terjangkau, tetapi CORS memblokir origin ' + h.origin + '.', fix: 'Hanya pengecekan dari browser yang terblokir; pengiriman asli lewat server tidak terpengaruh. Untuk menghilangkannya: deploy ulang push-send, atau tambahkan origin ini ke secret ALLOWED_ORIGIN.' });
  else if (h.net) add({ id: 'fn', ok: false, title: 'Edge Function push-send', detail: 'Tidak terjangkau dari browser: ' + h.net, fix: 'Periksa koneksi, SUPABASE_URL di config.js, dan CORS (secret ALLOWED_ORIGIN).' });
  else {
    add({ id: 'fn', ok: h.status === 200, title: 'Edge Function push-send', detail: h.status === 200 ? 'Berjalan.' : 'Merespons HTTP ' + h.status + (h.error ? ': ' + h.error : ''), fix: 'Lihat log fungsi: Dashboard, Edge Functions, push-send, Logs.' });
    add({ id: 'secrets', ok: !!h.secret_set && !!h.vapid_valid, title: 'Secrets Edge Function', detail: !h.secret_set ? 'PUSH_WEBHOOK_SECRET belum diisi.' : !h.vapid_valid ? 'Kunci VAPID server tidak valid: ' + (h.vapid_error || '') : 'PUSH_WEBHOOK_SECRET dan kunci VAPID terisi.', fix: 'supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:emailmu@domain.com PUSH_WEBHOOK_SECRET=... lalu deploy ulang.' });
    const same = h.vapid_public === VAPID_PUBLIC_KEY;
    add({ id: 'vapid', ok: same && !!h.vapid_match, title: 'Pasangan kunci VAPID', detail: !same ? 'VAPID_PUBLIC_KEY di server berbeda dari js/config.js.' : !h.vapid_match ? 'VAPID_PRIVATE_KEY di server BUKAN pasangan VAPID_PUBLIC_KEY. Push service akan menolak (403).' : 'Kunci publik di config.js, kunci publik server, dan kunci privat server saling cocok.', fix: 'Pakai ketiga nilai dari SATU hasil `node scripts/gen-vapid.mjs`. Setelah mengganti, matikan lalu nyalakan lagi Notifikasi di tiap perangkat.' });
  }
  // 5) database
  let d = null, dErr = null; { const r = await sb.rpc('push_diag'); d = r.data; dErr = r.error; }
  if (dErr) add({ id: 'db', ok: false, title: 'Database', detail: /could not find the function|schema cache|42883/i.test(errMsg(dErr)) ? 'Fungsi push_diag belum ada.' : errMsg(dErr), fix: 'Jalankan sql-parts/15a-push.sql lalu sql-parts/17a-fitur-chat.sql di SQL Editor.' });
  else {
    add({ id: 'dbcfg', ok: !!(d.has_url && d.has_secret), title: 'push_configure sudah dijalankan', detail: d.has_url && d.has_secret ? 'URL fungsi: ' + d.url_host : 'URL/secret belum disimpan.', fix: "select public.push_configure('https://<ref>.supabase.co/functions/v1/push-send', '<PUSH_WEBHOOK_SECRET>');" });
    add({ id: 'pgnet', ok: !!d.has_pg_net, title: 'Ekstensi pg_net', detail: d.has_pg_net ? 'Aktif.' : 'Belum aktif: database tidak bisa memanggil Edge Function.', fix: 'Dashboard, Database, Extensions, aktifkan pg_net.' });
    add({ id: 'trg', ok: !!d.trigger_message, title: 'Pemicu pesan baru', detail: d.trigger_message ? 'trg_push_message terpasang.' : 'Pemicu tidak ada.', fix: 'Jalankan ulang sql-parts/15a-push.sql.' });
    add({ id: 'dbsub', ok: d.my_subscriptions > 0, title: 'Langganan tersimpan di server', detail: d.my_subscriptions > 0 ? d.my_subscriptions + ' perangkat terdaftar untuk akunmu.' : 'Server belum menyimpan langganan akunmu.', fix: 'Matikan lalu nyalakan lagi sakelar Notifikasi.' });
  }
  if (!sendTestPush) return out;
  const prevAt = d && d.responses && d.responses[0] ? d.responses[0].created : null;
  const hardFail = out.some((s) => s.ok === false && ['browser', 'config', 'perm', 'sw', 'sub', 'dbcfg', 'pgnet'].includes(s.id));
  if (hardFail) { add({ id: 'e2e', ok: false, title: 'Uji kirim end-to-end', detail: 'Dilewati: perbaiki langkah merah di atas dulu.', fix: '' }); return out; }
  const t = await sb.rpc('push_test');
  if (t.error) { add({ id: 'e2e', ok: false, title: 'Uji kirim end-to-end', detail: errMsg(t.error), fix: '' }); return out; }
  // 6) tunggu respons HTTP dari Edge Function yang dicatat pg_net
  let resp = null;
  for (let i = 0; i < 8 && !resp; i++) { await wait(1500); const r = await sb.rpc('push_diag'); const x = r.data && r.data.responses && r.data.responses[0]; if (x && (!prevAt || x.created !== prevAt)) resp = x; }
  if (!resp) add({ id: 'e2e', ok: false, title: 'Uji kirim end-to-end', detail: 'Database tidak mencatat respons dari Edge Function dalam 12 detik. Permintaan tidak sampai atau terlalu lambat.', fix: 'Cek URL di push_configure (harus persis URL fungsi), pg_net aktif, dan log Edge Function.' });
  else {
    let body = null; try { body = JSON.parse(resp.body); } catch { /* bukan JSON */ }
    const code = resp.status_code;
    if (code === 200 && body && body.sent > 0) add({ id: 'e2e', ok: true, title: 'Uji kirim end-to-end', detail: 'Server berhasil mengirim ' + body.sent + ' notifikasi. Jika tidak terlihat, periksa mode Jangan Ganggu/Fokus dan penghemat baterai perangkat.', fix: '' });
    else add({ id: 'e2e', ok: false, title: 'Uji kirim end-to-end', detail: `Edge Function membalas HTTP ${code || '(tanpa respons)'}${body && body.error ? ': ' + body.error : body && body.hint ? ': ' + body.hint : body && body.reason ? ': ' + body.reason : resp.error ? ': ' + resp.error : resp.body ? ': ' + resp.body.slice(0, 160) : ''}${body && body.codes && body.codes.length ? ' (kode push service: ' + body.codes.join(', ') + ')' : ''}`, fix: code === 401 ? 'Secret berbeda. Jalankan ulang push_configure dengan PUSH_WEBHOOK_SECRET yang sama dengan di secrets.' : code === 404 ? 'URL salah / fungsi belum di-deploy.' : code >= 500 ? 'Lihat log Edge Function.' : '' });
  }
  return out;
}
