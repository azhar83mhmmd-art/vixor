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
