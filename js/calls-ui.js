// ORVIX — tampilan panggilan. Hanya merender state dari CallSession; tidak menyentuh WebRTC langsung.
import { bus, activeSession, joinCall, declineCall, getLimits } from './calls-core.js';
import { avatar, esc, toast } from './utils.js';

const P = {
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
  hang: '<g transform="rotate(135 12 12)"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/></g>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3z"/>',
  videooff: '<path d="M3 3l18 18"/><path d="M10 6h4a2 2 0 0 1 2 2v2l5-3v10l-3-1.8M3 8v8a2 2 0 0 0 2 2h8"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  micoff: '<path d="M3 3l18 18"/><path d="M9 9v2a3 3 0 0 0 5 2.2M15 9.3V6a3 3 0 0 0-5.6-1.5M5 11a7 7 0 0 0 11.2 5.6M19 11a7 7 0 0 1-.7 3M12 18v3"/>',
  flip: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><path d="M9.2 12.6a3 3 0 0 1 5.3-1.3l.6.8M14.8 14.4a3 3 0 0 1-5.3 1.3l-.6-.8"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.6A6.5 6.5 0 0 1 21.5 20"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
};
const ic = (n, s = 22) => `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${P[n]}</svg>`;
const $ = (s, r = document) => r.querySelector(s);
const kindTxt = (k) => (k === 'video' ? 'video' : 'suara');
const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const m = Math.floor(s / 60); return (m >= 60 ? Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0') : String(m)) + ':' + String(s % 60).padStart(2, '0'); };

bus.on('toast', (m) => toast(m, 'info'));

/* ---------------- nada dering ---------------- */
let ring = null;
function startRing() {
  stopRing();
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume().catch(() => {});
    const beep = () => { if (ac.state !== 'running') return; const o = ac.createOscillator(), g = ac.createGain(); o.type = 'sine'; o.frequency.value = 440; g.gain.setValueAtTime(0, ac.currentTime); g.gain.linearRampToValueAtTime(0.12, ac.currentTime + 0.05); g.gain.linearRampToValueAtTime(0, ac.currentTime + 0.9); o.connect(g).connect(ac.destination); o.start(); o.stop(ac.currentTime + 1); };
    beep(); ring = { ac, t: setInterval(() => { beep(); try { navigator.vibrate && navigator.vibrate([250, 150, 250]); } catch { /* abaikan */ } }, 2600) };
  } catch { ring = null; }
}
function stopRing() { if (ring) { clearInterval(ring.t); try { ring.ac.close(); } catch { /* abaikan */ } ring = null; try { navigator.vibrate && navigator.vibrate(0); } catch { /* abaikan */ } } }

/* ---------------- panggilan masuk ---------------- */
const inEls = new Map();
bus.on('incoming', (info) => {
  if (inEls.has(info.callId)) return;
  const el = document.createElement('div'); el.className = 'cl-in'; el.setAttribute('role', 'alertdialog'); el.setAttribute('aria-label', 'Panggilan masuk dari ' + info.name);
  const who = info.scope === 'group' ? `${esc(info.by || 'Seseorang')} memanggil di grup` : `Panggilan ${kindTxt(info.kind)} masuk`;
  el.innerHTML = `${avatar(info.name, info.avatar, 48)}<div class="cl-in-t"><b class="ell">${esc(info.name)}</b><span class="ell">${info.scope === 'group' ? who + ' · ' + kindTxt(info.kind) : who}</span></div>
    <button class="cl-rb bad" data-no aria-label="Tolak panggilan">${ic('hang', 24)}</button><button class="cl-rb good" data-yes aria-label="Terima panggilan">${ic(info.kind === 'video' ? 'video' : 'phone', 24)}</button>`;
  document.body.append(el); inEls.set(info.callId, el); if (inEls.size === 1) startRing();
  $('[data-no]', el).onclick = () => declineCall(info);
  $('[data-yes]', el).onclick = async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try { await joinCall(info); } catch (err) { b.disabled = false; if (!(err && err.shown)) toast(err && err.message ? err.message : 'Tidak bisa bergabung ke panggilan.', 'error'); }
  };
});
bus.on('incoming-gone', (id) => { const el = inEls.get(id); if (el) { el.classList.add('out'); setTimeout(() => el.remove(), 200); inEls.delete(id); } if (!inEls.size) stopRing(); });

/* ---------------- layar panggilan ---------------- */
let root = null, audioBox = null;
const audios = new Map();
function audioFor(id, stream) {
  if (!audioBox) { audioBox = document.createElement('div'); audioBox.id = 'cl-audio'; audioBox.hidden = true; document.body.append(audioBox); }
  let a = audios.get(id);
  if (!stream) { if (a) { a.srcObject = null; a.remove(); audios.delete(id); } return; }
  if (!a) { a = document.createElement('audio'); a.autoplay = true; a.playsInline = true; audioBox.append(a); audios.set(id, a); }
  if (a.srcObject !== stream) { a.srcObject = stream; a.play().catch(() => {}); }
}

bus.on('session', (s) => mount(s));

function mount(s) {
  unmount();
  document.body.classList.add('in-call');
  root = document.createElement('div'); root.className = 'cl'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'Layar panggilan');
  root.dataset.mode = s.scope; root.dataset.kind = s.kind;
  const title = (s.ctx && s.ctx.title) || 'Panggilan';
  root.innerHTML = `<header class="cl-top"><button class="cl-ib" data-min aria-label="Perkecil layar panggilan">${ic('down')}</button>
      <div class="cl-ttl"><b class="ell">${esc(title)}</b><span class="cl-st" aria-live="polite"></span></div>
      ${s.scope === 'group' ? `<button class="cl-ib" data-ppl aria-label="Daftar peserta">${ic('users')}<i class="cl-cnt"></i></button>` : '<span class="cl-ib ghost"></span>'}</header>
    <div class="cl-note" hidden></div>
    <main class="cl-grid" data-n="1"></main>
    <div class="cl-fail" hidden></div>
    <footer class="cl-bar" role="toolbar" aria-label="Kontrol panggilan">
      <div class="cl-bi"><button class="cl-cb" data-mic aria-pressed="false" aria-label="Matikan mikrofon">${ic('mic')}</button><span class="cl-lb" data-lmic>Senyapkan</span></div>
      ${s.kind === 'video' ? `<div class="cl-bi"><button class="cl-cb" data-cam aria-pressed="false" aria-label="Matikan kamera">${ic('video')}</button><span class="cl-lb" data-lcam>Video</span></div><div class="cl-bi" data-flipw hidden><button class="cl-cb" data-flip aria-label="Ganti kamera">${ic('flip')}</button><span class="cl-lb">Balik</span></div>` : ''}
      <div class="cl-bi"><button class="cl-cb end" data-end aria-label="Akhiri panggilan">${ic('hang', 26)}</button><span class="cl-lb">Akhiri</span></div>
    </footer>
    <aside class="cl-sheet" hidden aria-label="Peserta"><div class="cl-sh-h"><b>Peserta</b><button class="cl-ib" data-x aria-label="Tutup daftar">${ic('x')}</button></div><div class="cl-sh-b"></div></aside>`;
  document.body.append(root);
  const pill = document.createElement('div'); pill.className = 'cl-pill'; pill.hidden = true;
  pill.innerHTML = `<button class="cl-pill-b" data-back aria-label="Kembali ke panggilan">${ic('phone', 18)}<span class="ell"></span><time></time></button><button class="cl-pill-e" data-pend aria-label="Akhiri panggilan">${ic('hang', 18)}</button>`;
  document.body.append(pill); root._pill = pill;

  const tiles = new Map(); let pip = null;
  const grid = $('.cl-grid', root);
  const mic = $('[data-mic]', root), cam = $('[data-cam]', root), flip = $('[data-flip]', root);

  const setMin = (v) => { root.classList.toggle('min', v); pill.hidden = !v; document.body.classList.toggle('in-call-min', v); if (!v) $('[data-end]', root).focus({ preventScroll: true }); };
  $('[data-min]', root).onclick = () => setMin(true); $('[data-back]', pill).onclick = () => setMin(false); $('[data-pend]', pill).onclick = () => s.hangup();
  $('[data-end]', root).onclick = () => s.hangup();
  mic.onclick = () => s.toggleMic(); if (cam) cam.onclick = async () => { cam.disabled = true; await s.toggleCam(); cam.disabled = false; };
  if (flip) flip.onclick = () => s.switchCam();
  const sheet = $('.cl-sheet', root); const ppl = $('[data-ppl]', root);
  if (ppl) ppl.onclick = () => { sheet.hidden = !sheet.hidden; if (!sheet.hidden) paintSheet(s.view()); };
  $('[data-x]', root).onclick = () => { sheet.hidden = true; ppl && ppl.focus(); };

  const stateTxt = (r) => ({ idle: 'Berdering…', connecting: 'Menghubungkan…', reconnecting: 'Menyambung ulang…', failed: 'Koneksi gagal', left: 'Keluar' }[r.conn] || '');
  const dbTxt = (r) => (r.db === 'invited' ? 'Berdering…' : r.db === 'declined' ? 'Menolak' : r.db === 'missed' ? 'Tidak dijawab' : r.db === 'left' ? 'Keluar' : r.conn === 'connected' ? 'Terhubung' : stateTxt(r));

  function tileFor(r, isMe) {
    let t = tiles.get(r.id);
    if (!t) {
      t = document.createElement('div'); t.className = 'cl-tile'; t.dataset.id = r.id;
      t.innerHTML = `<video playsinline muted autoplay></video><div class="cl-ph"></div><div class="cl-meta"><span class="cl-mi" hidden>${ic('micoff', 14)}</span><span class="cl-nm ell"></span></div><div class="cl-ts" hidden></div><button class="cl-retry" hidden>Coba lagi</button>`;
      $('.cl-retry', t).onclick = () => s.retryPeer(r.id);
      t._isMe = isMe; tiles.set(r.id, t);
    }
    return t;
  }
  function paintTile(t, r, isMe) {
    const name = isMe ? 'Kamu' : r.name || (s.scope === 'direct' && s.ctx.title) || 'Pengguna';
    const showVid = s.kind === 'video' && (isMe ? s.camOn && s.local.video : r.cam && r.stream && r.stream.getVideoTracks().some((x) => x.readyState === 'live'));
    const v = $('video', t); const src = isMe ? s.local.stream : r.stream;
    if (v.srcObject !== (src || null)) { v.srcObject = src || null; if (src) v.play().catch(() => {}); }
    v.classList.toggle('mirror', isMe && s.facing === 'user');
    t.dataset.cam = showVid ? '1' : '0'; t.dataset.sp = r.speaking && (isMe ? s.micOn : true) ? '1' : '0';
    const ph = $('.cl-ph', t); const av = isMe ? (r.avatar) : (r.avatar || (s.scope === 'direct' && s.ctx.avatar) || null);
    const key = name + '|' + av; if (ph._k !== key) { ph._k = key; ph.innerHTML = avatar(name, av, 96); }
    $('.cl-nm', t).textContent = name;
    $('.cl-mi', t).hidden = !!(isMe ? s.micOn : r.mic);
    const ts = $('.cl-ts', t), rt = $('.cl-retry', t);
    const txt = isMe ? '' : (r.db === 'invited' ? 'Berdering…' : stateTxt(r)); ts.hidden = !txt || r.conn === 'connected'; ts.textContent = r.conn === 'connected' ? '' : txt; rt.hidden = isMe || r.conn !== 'failed';
    t.dataset.cs = r.conn;
  }

  function paint(view) {
    const meR = view[0]; const others = view.slice(1);
    const showOthers = others.filter((r) => r.db === 'joined' || (s.scope === 'direct' && (r.db === 'invited' || r.db === 'joined')));
    const direct = s.scope === 'direct';
    const vidDirect = direct && s.kind === 'video';
    // tile lawan / peserta. Panggilan pribadi hanya menampilkan lawan bicara (foto profilnya), bukan fotomu sendiri.
    const order = [...showOthers]; const seq = [...(!direct ? [[meR, true]] : []), ...order.map((r) => [r, false])];
    if (!seq.length && direct) seq.push([{ id: 'x', db: 'invited', conn: 'idle', mic: true }, false]);
    const want = new Set(seq.map(([r]) => r.id)); want.add(meR.id);
    order.forEach((r) => audioFor(r.id, r.stream));
    others.filter((r) => r.db !== 'joined').forEach((r) => audioFor(r.id, null));
    tiles.forEach((t, id) => { if (!want.has(id) && id !== meR.id) { t.remove(); tiles.delete(id); } });
    if (direct && !vidDirect) { const mt = tiles.get(meR.id); if (mt) { mt.remove(); tiles.delete(meR.id); } }
    seq.forEach(([r, isMe], i) => { const t = tileFor(r, isMe); paintTile(t, r, isMe); if (grid.children[i] !== t) grid.insertBefore(t, grid.children[i] || null); });
    grid.dataset.n = String(Math.max(1, seq.length));
    // PiP lokal untuk video pribadi
    if (vidDirect) {
      if (!pip) { pip = tileFor(meR, true); pip.classList.add('cl-pip'); root.append(pip); drag(pip); }
      paintTile(pip, meR, true); pip.hidden = !s.camOn;
    } else if (pip) { pip.remove(); tiles.delete(meR.id); pip = null; }
    // kontrol
    mic.setAttribute('aria-pressed', String(!s.micOn)); mic.classList.toggle('off', !s.micOn); mic.innerHTML = ic(s.micOn ? 'mic' : 'micoff'); mic.setAttribute('aria-label', s.micOn ? 'Matikan mikrofon' : 'Nyalakan mikrofon'); $('[data-lmic]', root).textContent = s.micOn ? 'Senyapkan' : 'Bunyikan';
    if (cam) { cam.setAttribute('aria-pressed', String(!s.camOn)); cam.classList.toggle('off', !s.camOn); cam.innerHTML = ic(s.camOn ? 'video' : 'videooff'); cam.setAttribute('aria-label', s.camOn ? 'Matikan kamera' : 'Nyalakan kamera'); $('[data-lcam]', root).textContent = s.camOn ? 'Video' : 'Video mati'; }
    if (flip) $('[data-flipw]', root).hidden = !(s.canSwitch && s.camOn);
    const joined = view.filter((r) => r.db === 'joined').length; const cnt = $('.cl-cnt', root); if (cnt) cnt.textContent = `${joined}/${s.max}`;
    const note = $('.cl-note', root); const nt = s.camNote; note.hidden = !nt; note.textContent = nt || '';
    paintSheet(view); status();
  }
  function paintSheet(view) {
    if (sheet.hidden) return;
    $('.cl-sh-b', sheet).innerHTML = view.map((r, i) => `<div class="cl-pr">${avatar(i ? r.name || 'Pengguna' : 'Kamu', r.avatar, 36)}<span class="grow ell"><b>${esc(i ? r.name || 'Pengguna' : 'Kamu')}</b><small>${i ? dbTxt(r) : 'Terhubung'}</small></span>${(i ? r.mic : s.micOn) ? '' : ic('micoff', 16)}${s.kind === 'video' && !(i ? r.cam : s.camOn) && (i ? r.db === 'joined' : true) ? ic('videooff', 16) : ''}</div>`).join('');
  }
  function status() {
    const el = $('.cl-st', root); const st = s.status;
    const txt = { preparing: 'Menyiapkan…', ringing: s.likelyOnline === false ? 'Memanggil… (kemungkinan sedang offline)' : 'Berdering…', waiting: 'Menunggu peserta lain', connecting: 'Menyambungkan…', reconnecting: 'Menyambung ulang…', failed: 'Koneksi gagal', ended: (s.endInfo && s.endInfo.text) || 'Panggilan berakhir' }[st];
    el.textContent = st === 'connected' ? mmss(Date.now() - (s.connectedAt || Date.now())) : txt || '';
    root.dataset.st = st; pill.querySelector('.ell').textContent = title; pill.querySelector('time').textContent = st === 'connected' ? mmss(Date.now() - (s.connectedAt || Date.now())) : (txt || '');
    const f = $('.cl-fail', root); f.hidden = st !== 'failed';
    if (st === 'failed') f.innerHTML = `<p>Koneksi langsung tidak bisa dibuat. Sebagian jaringan (misalnya data seluler tertentu atau Wi‑Fi kantor) memblokir koneksi peer-to-peer dan memerlukan server TURN, yang tidak dipakai ORVIX. Coba pindah jaringan, lalu coba lagi.</p><div class="row gap"><button class="btn primary" data-rt>Coba lagi</button></div>`;
    const rb = f.querySelector('[data-rt]'); if (rb) rb.onclick = () => s.retryAll();
  }

  s.on('roster', paint); s.on('local', () => paint(s.view())); s.on('status', status);
  s.on('error', (m) => toast(m, 'error'));
  const tick = setInterval(() => { if (s.status === 'connected') status(); }, 1000);
  root._tick = tick;
  s.on('ended', (info) => {
    status(); root.classList.add('ended'); clearInterval(tick);
    $('.cl-bar', root).innerHTML = info.failed ? `<div class="cl-bi"><button class="cl-cb end" data-close aria-label="Tutup">${ic('hang', 26)}</button><span class="cl-lb">Tutup</span></div>` : '';
    const c = $('[data-close]', root); if (c) c.onclick = unmount;
    if (!info.failed) setTimeout(unmount, 1800);
  });
  paint(s.view());
  setTimeout(() => $('[data-end]', root) && $('[data-end]', root).focus({ preventScroll: true }), 50);
}

function drag(el) {
  let sx, sy, ox, oy, on = false;
  el.addEventListener('pointerdown', (e) => { on = true; sx = e.clientX; sy = e.clientY; const r = el.getBoundingClientRect(); ox = r.left; oy = r.top; el.setPointerCapture(e.pointerId); el.classList.add('drag'); });
  el.addEventListener('pointermove', (e) => { if (!on) return; const w = el.offsetWidth, h = el.offsetHeight; el.style.left = Math.min(Math.max(8, ox + e.clientX - sx), innerWidth - w - 8) + 'px'; el.style.top = Math.min(Math.max(8, oy + e.clientY - sy), innerHeight - h - 8) + 'px'; el.style.right = 'auto'; el.style.bottom = 'auto'; });
  const end = () => { on = false; el.classList.remove('drag'); }; el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
}

function unmount() {
  if (!root) return;
  clearInterval(root._tick); root._pill && root._pill.remove(); root.querySelectorAll('video').forEach((v) => { v.srcObject = null; }); root.remove(); root = null;
  audios.forEach((a, id) => audioFor(id, null)); document.body.classList.remove('in-call', 'in-call-min');
}
bus.on('session-end', () => { /* unmount dijalankan oleh handler 'ended' */ });

export { getLimits };
