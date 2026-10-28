// Fitur chat tambahan: kunci chat (PIN per perangkat), pemilih emoji, pemilih teruskan, bisukan, daftar pesan berbintang.
import { sb, errMsg } from './supabase.js';
import { $, $$, esc, icon, avatar, openModal, toast, setBusy, fmtTime, relTime, debounce } from './utils.js';

/* ================= Kunci chat (PIN) =================
   Kunci ini adalah pengaman layar PER PERANGKAT: chat terkunci disembunyikan dari daftar dan hanya terbuka setelah PIN benar.
   Bukan enkripsi: pesan tetap tersimpan normal di server dan terbaca dari perangkat lain yang login ke akun yang sama. */
const PK = (uid) => 'orvix:lockpin:' + uid, OPEN = 'orvix:lockopen', FAIL = 'orvix:lockfail';
const enc = new TextEncoder(), b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))), unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function derive(pin, salt, it = 150000) {
  const k = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: it }, k, 256));
}
const rd = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
export const hasPin = (uid) => !!rd(PK(uid));
export async function setPin(uid, pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16)); const h = await derive(pin, salt);
  try { localStorage.setItem(PK(uid), JSON.stringify({ s: b64(salt), h, i: 150000 })); } catch { throw new Error('Penyimpanan perangkat tidak tersedia.'); }
}
async function checkPin(uid, pin) { const r = rd(PK(uid)); if (!r) return false; return (await derive(pin, unb64(r.s), r.i)) === r.h; }
export const clearPin = (uid) => { try { localStorage.removeItem(PK(uid)); } catch { /* abaikan */ } };
export const isUnlocked = () => { try { return Date.now() < +sessionStorage.getItem(OPEN); } catch { return false; } };
export const unlockSession = (mins = 5) => { try { sessionStorage.setItem(OPEN, String(Date.now() + mins * 60000)); } catch { /* abaikan */ } };
export const lockSession = () => { try { sessionStorage.removeItem(OPEN); } catch { /* abaikan */ } };
let hiddenAt = 0; const relockCbs = [];
export const onRelock = (f) => relockCbs.push(f);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (hiddenAt && Date.now() - hiddenAt > 60000 && isUnlocked()) { lockSession(); relockCbs.forEach((f) => f()); hiddenAt = 0; }
});
const throttle = () => { const f = rd(FAIL) || { n: 0, until: 0 }; return f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0; };
const failed = () => { const f = rd(FAIL) || { n: 0, until: 0 }; f.n++; if (f.n >= 5) { f.until = Date.now() + 30000 * Math.min(f.n - 4, 10); } try { localStorage.setItem(FAIL, JSON.stringify(f)); } catch { /* abaikan */ } };
const passed = () => { try { localStorage.removeItem(FAIL); } catch { /* abaikan */ } };

// mode: 'verify' (buka), 'set' (buat PIN baru). Mengembalikan Promise<boolean>.
export function pinDialog({ me, mode = 'verify', title, note }) {
  return new Promise((resolve) => {
    let done = false, first = null;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const m = openModal({ title: title || (mode === 'set' ? 'Buat PIN kunci chat' : 'Masukkan PIN'), cls: 'pinm', onClose: () => fin(false), html: `<p class="muted" id="pnote" style="margin-bottom:12px">${esc(note || (mode === 'set' ? 'Pilih PIN 4 sampai 6 angka. PIN hanya tersimpan di perangkat ini.' : 'Masukkan PIN untuk membuka chat terkunci.'))}</p><div class="pin-dots" id="pdots" aria-hidden="true"></div><input class="inp pin-in" id="pin" type="password" inputmode="numeric" autocomplete="off" maxlength="6" pattern="[0-9]*" aria-label="PIN" placeholder="••••"><p class="err" id="perr" role="alert" style="text-align:center;margin-top:8px"></p><button class="btn primary block" id="pgo">${mode === 'set' ? 'Lanjut' : 'Buka'}</button>${mode === 'verify' ? '<button class="btn ghost block" id="pforgot" style="margin-top:8px">Lupa PIN</button>' : ''}` });
    const inp = $('#pin', m.el), err = $('#perr', m.el), dots = $('#pdots', m.el);
    const paint = () => { dots.innerHTML = Array.from({ length: 6 }, (_, i) => `<i class="${i < inp.value.length ? 'on' : ''}"></i>`).join(''); };
    paint(); inp.oninput = () => { inp.value = inp.value.replace(/\D/g, '').slice(0, 6); err.textContent = ''; paint(); };
    const go = async () => {
      const v = inp.value; if (v.length < 4) { err.textContent = 'PIN minimal 4 angka.'; return; }
      const b = $('#pgo', m.el); setBusy(b, true);
      try {
        if (mode === 'set') {
          if (first === null) { first = v; inp.value = ''; paint(); $('#pnote', m.el).textContent = 'Ulangi PIN untuk konfirmasi.'; b.textContent = 'Simpan'; setBusy(b, false); b.textContent = 'Simpan'; return; }
          if (v !== first) { first = null; inp.value = ''; paint(); err.textContent = 'PIN tidak sama. Ulangi dari awal.'; $('#pnote', m.el).textContent = 'Pilih PIN 4 sampai 6 angka.'; setBusy(b, false); b.textContent = 'Lanjut'; return; }
          await setPin(me.id, v); unlockSession(); fin(true); m.close(); return;
        }
        const wait = throttle(); if (wait) { err.textContent = `Terlalu banyak percobaan. Coba lagi dalam ${wait} detik.`; setBusy(b, false); return; }
        if (await checkPin(me.id, v)) { passed(); unlockSession(); fin(true); m.close(); return; }
        failed(); inp.value = ''; paint(); err.textContent = 'PIN salah.'; setBusy(b, false);
      } catch (e) { err.textContent = errMsg(e); setBusy(b, false); }
    };
    $('#pgo', m.el).onclick = go; inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
    const fg = $('#pforgot', m.el); if (fg) fg.onclick = async () => { fin(false); m.close(); const ok = await resetPinFlow(me); if (ok) toast('PIN diatur ulang', 'success'); };
  });
}
// Lupa PIN: verifikasi ulang dengan kata sandi akun, lalu buat PIN baru.
export function resetPinFlow(me) {
  return new Promise((resolve) => {
    let ok = false;
    const m = openModal({ title: 'Atur ulang PIN', onClose: () => resolve(ok), html: `<p class="muted" style="margin-bottom:12px">Masukkan kata sandi akun ORVIX untuk membuat PIN baru. Chat yang sudah dikunci tetap terkunci.</p><div class="field"><label for="rpw">Kata sandi</label><input class="inp" id="rpw" type="password" autocomplete="current-password"></div><p class="err" id="rpe" role="alert"></p><button class="btn primary block" id="rpg">Lanjut</button>` });
    $('#rpg', m.el).onclick = async (e) => {
      const b = e.currentTarget, pw = $('#rpw', m.el).value; if (!pw) return;
      setBusy(b, true); const { data } = await sb.auth.getSession(); const email = data.session?.user?.email;
      const r = email ? await sb.auth.signInWithPassword({ email, password: pw }) : { error: new Error('Akun tidak memiliki email untuk verifikasi.') };
      if (r.error) { setBusy(b, false); $('#rpe', m.el).textContent = 'Kata sandi salah.'; return; }
      m.close(); clearPin(me.id); ok = await pinDialog({ me, mode: 'set' }); resolve(ok);
    };
  });
}
// Pastikan PIN ada dan sesi terbuka. Mengembalikan true bila boleh melanjutkan.
export async function ensureUnlocked(me, why) {
  if (!hasPin(me.id)) return pinDialog({ me, mode: 'set', note: 'Buat PIN dulu untuk memakai kunci chat. PIN hanya tersimpan di perangkat ini.' });
  if (isUnlocked()) { unlockSession(); return true; }
  return pinDialog({ me, mode: 'verify', note: why });
}

/* ================= Pemilih emoji ================= */
const EMO = [
  ['Wajah', '😀😃😄😁😆😅😂🤣🥲😊😇🙂🙃😉😌😍🥰😘😗😙😚😋😛😝😜🤪🤨🧐🤓😎🥸🤩🥳😏😒😞😔😟😕🙁☹️😣😖😫😩🥺😢😭😤😠😡🤬🤯😳🥵🥶😱😨😰😥😓🤗🤔🫣🤭🫢🤫🤥😶😐😑😬🫠🙄😯😦😧😮😲🥱😴🤤😪😵🤐🥴🤢🤮🤧😷🤒🤕🤑🤠😈👿👻💀☠️👽🤖💩'],
  ['Tangan', '👍👎👊✊🤛🤜👏🙌🫶👐🤲🤝🙏✌️🤞🫰🤟🤘👌🤌🤏👈👉👆👇☝️✋🤚🖐️🖖👋🤙💪🦾🖕✍️🤳💅'],
  ['Hati', '❤️🧡💛💚💙💜🖤🤍🤎💔❣️💕💞💓💗💖💘💝💟☮️✝️☪️🕉️☸️✡️🔯🕎☯️💯✨⭐🌟💫🔥💥🎉🎊🎈🎁🏆🥇'],
  ['Hewan', '🐶🐱🐭🐹🐰🦊🐻🐼🐨🐯🦁🐮🐷🐸🐵🙈🙉🙊🐔🐧🐦🐤🦆🦅🦉🦇🐺🐗🐴🦄🐝🐛🦋🐌🐞🐜🐢🐍🦎🐙🦑🦀🐠🐟🐬🐳🐋🦈🐊🐅🐘🦒🐪🦘🐕🐈🌸🌹🌺🌻🌼🌷🌱🌴🌵🍀🍁🍂'],
  ['Makanan', '🍏🍎🍐🍊🍋🍌🍉🍇🍓🫐🍈🍒🍑🥭🍍🥥🥝🍅🥑🍆🌽🥕🥔🍞🧀🥚🍳🥓🍔🍟🍕🌭🥪🌮🌯🍜🍝🍣🍱🍚🍛🍢🍡🍦🍩🍪🎂🍰🍫🍬🍭☕🍵🥤🍺🍷'],
  ['Aktivitas', '⚽🏀🏈⚾🎾🏐🏉🎱🏓🏸🥊🎮🕹️🎲🧩🎯🎳🎧🎤🎬🎨🎸🎹🥁🎷🎺🚗🚕🚌🏎️🛵🚲✈️🚀🛸🏠🏝️🌋⛰️🌅🌃'],
];
export function emojiPicker({ anchor, onPick }) {
  const old = $('#emopop'); if (old) { old.remove(); return null; }
  const pop = document.createElement('div'); pop.id = 'emopop'; pop.className = 'emopop'; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', 'Pilih emoji');
  pop.innerHTML = `<div class="emo-tabs">${EMO.map((c, i) => `<button type="button" data-ei="${i}" class="${i ? '' : 'on'}">${esc([...c[1]][0])}</button>`).join('')}</div><div class="emo-grid" id="emog"></div>`;
  const draw = (i) => { $('#emog', pop).innerHTML = [...new Intl.Segmenter('id', { granularity: 'grapheme' }).segment(EMO[i][1])].map((s) => `<button type="button" data-e="${esc(s.segment)}">${esc(s.segment)}</button>`).join(''); };
  draw(0);
  pop.onclick = (e) => { const t = e.target.closest('[data-ei]'); if (t) { $$('[data-ei]', pop).forEach((b) => b.classList.toggle('on', b === t)); draw(+t.dataset.ei); return; } const b = e.target.closest('[data-e]'); if (b) onPick(b.dataset.e); };
  const close = (e) => { if (e && (pop.contains(e.target) || anchor.contains(e.target))) return; pop.remove(); document.removeEventListener('pointerdown', close, true); };
  setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
  (anchor.closest('.thread-pane') || document.body).append(pop); return pop;
}
export const QUICK = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

/* ================= Teruskan: pilih percakapan ================= */
export function forwardPicker({ convs, name, avOf, title = 'Teruskan ke…' }) {
  return new Promise((resolve) => {
    const sel = new Set(); let done = false;
    const m = openModal({ title, cls: 'fwd', onClose: () => { if (!done) resolve([]); }, html: `<div class="csearch" style="margin-bottom:10px">${icon('search', 18)}<input id="fq" type="search" placeholder="Cari chat" aria-label="Cari chat" autocomplete="off"></div><div id="fl" class="col" style="gap:2px;max-height:50vh;overflow:auto"></div><button class="btn primary block" id="fgo" disabled style="margin-top:12px">Kirim</button>` });
    const list = $('#fl', m.el), go = $('#fgo', m.el);
    const draw = () => {
      const s = $('#fq', m.el).value.trim().toLowerCase(), rows = convs.filter((c) => c.conv_type !== 'channel' && !s || (c.conv_type !== 'channel' && name(c).toLowerCase().includes(s)));
      list.innerHTML = rows.length ? rows.map((c) => `<label class="row gap fwd-row"><input type="checkbox" value="${c.conv_id}" ${sel.has(c.conv_id) ? 'checked' : ''}>${avOf(c)}<span class="grow ell">${esc(name(c))}</span></label>`).join('') : '<p class="dim" style="padding:14px;text-align:center">Tidak ada chat.</p>';
    };
    draw(); $('#fq', m.el).oninput = debounce(draw, 150);
    list.onchange = (e) => { const c = e.target; if (!c.value) return; c.checked ? (sel.size < 5 ? sel.add(c.value) : ((c.checked = false), toast('Maksimal 5 chat sekaligus', 'error'))) : sel.delete(c.value); go.disabled = !sel.size; go.textContent = sel.size ? `Kirim ke ${sel.size} chat` : 'Kirim'; };
    go.onclick = () => { done = true; resolve([...sel]); m.close(); };
  });
}

/* ================= Bisukan ================= */
export function mutePicker(current) {
  return new Promise((resolve) => {
    let done = false;
    const opts = [['8 jam', 8 * 3600e3], ['1 minggu', 7 * 86400e3], ['Selamanya', Infinity]];
    const m = openModal({ title: 'Bisukan notifikasi', sheet: true, onClose: () => { if (!done) resolve(undefined); }, html: `<p class="muted" style="margin-bottom:10px">Pesan tetap masuk, tetapi tanpa notifikasi.</p><div class="col">${opts.map(([l], i) => `<button class="btn" data-o="${i}">${l}</button>`).join('')}${current ? '<button class="btn danger" data-o="off">Bunyikan lagi</button>' : ''}</div>` });
    m.el.onclick = (e) => { const b = e.target.closest('[data-o]'); if (!b) return; done = true; const o = b.dataset.o; resolve(o === 'off' ? null : opts[+o][1] === Infinity ? 'infinity' : new Date(Date.now() + opts[+o][1]).toISOString()); m.close(); };
  });
}
export const isMuted = (c) => !!c.muted_until && (c.muted_until === 'infinity' || new Date(c.muted_until) > new Date());

/* ================= Pesan berbintang ================= */
export async function starredModal({ me, ensureProfiles, prof, titleOf, onOpen }) {
  const m = openModal({ title: 'Pesan berbintang', wide: true, html: '<div id="stl" class="col" style="gap:8px"><p class="dim">Memuat…</p></div>' });
  const box = $('#stl', m.el);
  const { data, error } = await sb.from('orvix_msg_starred').select('created_at,message:messages(id,conversation_id,sender_id,content,message_type,media_type,created_at,deleted_at)').order('created_at', { ascending: false }).limit(100);
  if (error) { box.innerHTML = `<p class="err">${esc(/relationship|does not exist|schema cache|42P01/i.test(errMsg(error)) ? 'Fitur belum aktif di database. Jalankan sql-parts/17a-fitur-chat.sql.' : errMsg(error))}</p>`; return; }
  const rows = (data || []).filter((r) => r.message && !r.message.deleted_at);
  await ensureProfiles([...new Set(rows.map((r) => r.message.sender_id))]);
  box.innerHTML = rows.length ? rows.map((r) => { const x = r.message, who = x.sender_id === me.id ? 'Kamu' : prof.get(x.sender_id)?.display_name || 'Anggota'; return `<button class="card star-row" data-c="${x.conversation_id}" data-m="${x.id}"><span class="row between"><b>${esc(who)}</b><span class="dim">${esc(titleOf(x.conversation_id))} · ${esc(relTime(x.created_at))}</span></span><span class="star-t">${x.media_type === 'audio' ? '🎤 Pesan suara' : x.media_type ? (x.media_type === 'video' ? '🎥 Video' : '📷 Foto') : esc(x.content)}</span></button>`; }).join('') : `<div class="empty" style="padding:24px">${icon('star', 36)}<h3>Belum ada pesan berbintang</h3><p>Ketuk sebuah pesan, lalu pilih Bintangi untuk menyimpannya di sini.</p></div>`;
  box.onclick = (e) => { const b = e.target.closest('[data-c]'); if (!b) return; m.close(); onOpen(b.dataset.c, b.dataset.m); };
}
