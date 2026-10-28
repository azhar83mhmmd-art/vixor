// Utilitas UI bersama: ikon, badge verified, toast, modal, navigasi.
import './emoji.js';
export const THEMES = { orvix: ['ORVIX', 'Gelap, aksen biru elektrik dan cyan', '#05070B'], brutal: ['Neo Brutalism', 'Krem terang, border hitam tebal, bayangan keras, aksen kuning, pink, dan biru', '#FFD43B'], glass: ['Glassmorphism', 'Kaca gelap buram dengan aurora yang bergerak pelan', '#0A0E1C'] };
// Terapkan tema ke seluruh halaman (atribut data-theme di <html>) dan simpan lokal agar tidak berkedip saat dimuat ulang.
/* ================= Wallpaper chat (seperti WhatsApp) ================= */
// Disimpan per perangkat. dim 0-100 = kepudaran: 0 = wallpaper asli, 100 = tertutup penuh warna latar.
const WP_KEY = 'orvix:wp';
export const WALLPAPERS = [
  { id: 'doodle', n: 'Doodle' }, { id: 'polos', n: 'Polos' }, { id: 'grid', n: 'Kotak' },
  { id: 'teal', n: 'Teal', g: ['#0F2A2E', '#1A4543', '#CFF5E3', '#9FE3C0'] }, { id: 'senja', n: 'Senja', g: ['#2B2233', '#5A3A45', '#FFD6A5', '#FF9EB7'] },
  { id: 'hutan', n: 'Hutan', g: ['#10201A', '#244A38', '#C8F0B8', '#8FDDA4'] }, { id: 'samudra', n: 'Samudra', g: ['#0E1C2C', '#1F4160', '#BFE2FF', '#7CC4FF'] },
  { id: 'malam', n: 'Malam', g: ['#0B0E17', '#212843', '#E2D4FF', '#B7A6FF'] },
];
const DOODLE = (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220" viewBox="0 0 220 220" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M30 38c-6-8 4-17 10-9 6-8 16 1 10 9l-10 10z"/><path d="M120 24l4 9 10 1-7 7 2 10-9-5-9 5 2-10-7-7 10-1z"/><path d="M178 36h22a6 6 0 016 6v12a6 6 0 01-6 6h-12l-8 7v-7h-2a6 6 0 01-6-6V42a6 6 0 016-6z"/><circle cx="70" cy="96" r="11"/><path d="M150 92l12 20h-24z"/><path d="M26 140h22M37 129v22"/><path d="M96 150c0-9 14-9 14 0s-14 18-14 18-14-9-14-18"/><path d="M186 140a14 14 0 11-10 24 10 10 0 0010-24z"/><path d="M60 196c6-10 12 10 18 0s12 10 18 0"/><path d="M150 188l10-12 10 12"/></svg>`;
const svgUrl = (x) => `url("data:image/svg+xml,${encodeURIComponent(x)}")`;
export const getWallpaper = () => { try { const w = JSON.parse(localStorage.getItem(WP_KEY) || 'null'); if (w && typeof w === 'object') return { id: w.id || 'doodle', dim: Math.min(100, Math.max(0, +w.dim >= 0 ? +w.dim : 30)), img: w.img || null }; } catch { /* abaikan */ } return { id: 'doodle', dim: 30, img: null }; };
export function wpStyle(w = getWallpaper(), theme = currentTheme()) {
  const light = theme === 'brutal', ov = light ? '255,246,220' : '0,0,0', st = light ? '17,17,17' : '255,255,255', base = light ? '#FFF1C9' : theme === 'glass' ? '#0F151B' : '#0F1519';
  let img = 'none', size = 'cover', rep = 'no-repeat', bg = base;
  if (w.id === 'custom' && w.img) img = `url("${w.img}")`;
  else if (w.id === 'doodle') { img = svgUrl(DOODLE(`rgba(${st},${light ? .16 : .075})`)); size = '220px'; rep = 'repeat'; }
  else if (w.id === 'grid') { img = svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28"><path d="M0 .5H28M.5 0V28" stroke="rgba(${st},${light ? .12 : .06})" fill="none"/></svg>`); size = '28px 28px'; rep = 'repeat'; }
  else if (w.id !== 'polos') { const d = WALLPAPERS.find((x) => x.id === w.id); if (d?.g) { const [a, b] = light ? [d.g[2], d.g[3]] : [d.g[0], d.g[1]]; img = `linear-gradient(160deg,${a},${b})`; } }
  return { '--wp-img': img, '--wp-size': size, '--wp-rep': rep, '--wp-bg': bg, '--wp-ov': ov, '--wp-a': (w.dim / 100).toFixed(2) };
}
export function applyWallpaper(w = getWallpaper()) { const r = document.documentElement; Object.entries(wpStyle(w)).forEach(([k, v]) => r.style.setProperty(k, v)); }
export function saveWallpaper(w) { try { localStorage.setItem(WP_KEY, JSON.stringify(w)); } catch { return false; } applyWallpaper(w); return true; }
async function shrinkImage(file, max = 1280) {
  const url = URL.createObjectURL(file);
  try { const im = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('Gambar tidak bisa dibaca')); i.src = url; });
    const k = Math.min(1, max / Math.max(im.width, im.height)), c = document.createElement('canvas'); c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
    c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', 0.74); } finally { URL.revokeObjectURL(url); }
}
export function wallpaperModal() {
  let w = getWallpaper();
  const tiles = () => [...WALLPAPERS, ...(w.img ? [{ id: 'custom', n: 'Foto saya' }] : [])].map((x) => `<button type="button" class="wp-t" role="radio" aria-checked="${w.id === x.id}" data-wp="${x.id}" aria-label="Wallpaper ${x.n}"><span class="wp-sw" style="${Object.entries(wpStyle({ ...w, id: x.id, dim: 0 })).map(([k, v]) => `${k}:${String(v).replace(/"/g, '&quot;')}`).join(';')}"></span><small>${x.n}</small></button>`).join('');
  const m = openModal({ title: 'Wallpaper chat', html: `<div class="wp-prev msgs" aria-hidden="true"><span class="wp-b in">Halo! Ini contoh wallpaper chat kamu</span><span class="wp-b out">Mantap, terlihat jelas 👍</span></div>
    <div class="field" style="margin-top:14px"><label for="wpd">Kepudaran: <b id="wpv">${w.dim}</b>%</label><input id="wpd" type="range" min="0" max="100" step="1" value="${w.dim}" style="width:100%"><p class="hint">0 = wallpaper apa adanya, 100 = tertutup penuh.</p></div>
    <div class="wp-grid" id="wpg" role="radiogroup" aria-label="Pilih wallpaper">${tiles()}</div>
    <div class="row gap" style="margin-top:14px;flex-wrap:wrap"><button class="btn" id="wpu">${icon('image', 18)} Pakai fotoku</button><button class="btn" id="wpr">Kembali ke default</button></div><input id="wpf" type="file" accept="image/jpeg,image/png,image/webp" hidden>` });
  const live = () => { saveWallpaper(w) || toast('Penyimpanan perangkat penuh. Wallpaper hanya berlaku sementara.', 'error'); const g = $('#wpg', m.el); g.innerHTML = tiles(); };
  $('#wpd', m.el).oninput = (e) => { w = { ...w, dim: +e.target.value }; $('#wpv', m.el).textContent = w.dim; applyWallpaper(w); };
  $('#wpd', m.el).onchange = () => saveWallpaper(w);
  $('#wpg', m.el).onclick = (e) => { const b = e.target.closest('[data-wp]'); if (!b) return; w = { ...w, id: b.dataset.wp }; live(); };
  $('#wpu', m.el).onclick = () => $('#wpf', m.el).click();
  $('#wpf', m.el).onchange = async (e) => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; if (!/^image\/(jpeg|png|webp)$/.test(f.type)) return toast('Pilih gambar JPG, PNG, atau WEBP', 'error'); try { w = { ...w, id: 'custom', img: await shrinkImage(f) }; live(); } catch (er) { toast(er.message || 'Gagal memuat gambar', 'error'); } };
  $('#wpr', m.el).onclick = () => { w = { id: 'doodle', dim: 30, img: null }; $('#wpd', m.el).value = 30; $('#wpv', m.el).textContent = 30; live(); };
}

// origin {x,y} (opsional): titik klik; bila browser mendukung View Transitions, tema baru "menyebar" dari titik itu.
export function applyTheme(t, origin) {
  if (!THEMES[t]) t = 'orvix'; const r = document.documentElement, same = currentTheme() === t;
  const set = () => { if (t === 'orvix') delete r.dataset.theme; else r.dataset.theme = t; applyWallpaper(); };
  try { localStorage.setItem('orvix:theme', t); } catch { /* abaikan */ }
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = THEMES[t][2];
  const calm = matchMedia('(prefers-reduced-motion:reduce)').matches;
  if (origin && !same && !calm && document.startViewTransition) {
    const { x, y } = origin, rad = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    r.classList.add('theme-vt');
    const vt = document.startViewTransition(set);
    vt.ready.then(() => r.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${rad}px at ${x}px ${y}px)`] }, { duration: 750, easing: 'cubic-bezier(.22,.8,.24,1)', pseudoElement: '::view-transition-new(root)' })).catch(() => {});
    vt.finished.finally(() => r.classList.remove('theme-vt'));
    return t;
  }
  r.classList.add('theme-fade'); clearTimeout(applyTheme.t); applyTheme.t = setTimeout(() => r.classList.remove('theme-fade'), 450);
  set(); return t;
}

/* ---- Premium: gaya tampilan (aktif hanya selama Premium berlaku) ---- */
export const isPremium = (p) => !!p?.premium_until && new Date(p.premium_until).getTime() > Date.now();
export const LOOKS = { bubble: ['default', 'aurora', 'sunset', 'mint', 'rose', 'mono', 'gold'], accent: ['default', 'aurora', 'sunset', 'mint', 'rose', 'gold'] };
export function applyLook(p) {
  const r = document.documentElement, pr = (isPremium(p) && p.premium_prefs) || {};
  const set = (k, v, list) => { if (v && v !== 'default' && list.includes(v)) r.dataset[k] = v; else delete r.dataset[k]; };
  set('bubble', pr.bubble, LOOKS.bubble); set('accent', pr.accent, LOOKS.accent);
  if (pr.ring && isPremium(p)) r.dataset.ring = '1'; else delete r.dataset.ring;
}
export const currentTheme = () => document.documentElement.dataset.theme || 'orvix';
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

const P = {
  pin: '<path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z"/><path d="M12 14v7"/>',
  mic: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  forward: '<path d="m15 7 5 5-5 5M20 12H9a5 5 0 0 0-5 5v1"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14a4 4 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/>',
  unread: '<circle cx="12" cy="12" r="4.5" fill="currentColor"/><circle cx="12" cy="12" r="9"/>',
  mutebell: '<path d="M6 16V11a6 6 0 0 1 9-5.2M18 11v5l2 2H4M10 21h4M3 3l18 18"/>',
  arrowdown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  crown: '<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  unlock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>',
  selall: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12l3 3 5-6"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  updates: '<circle cx="12" cy="12" r="3"/><path d="M12 3a9 9 0 1 0 9 9" stroke-dasharray="3 3"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20a7 7 0 0 1 14 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a7 7 0 0 1 4 6"/>',
  userplus: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20a7 7 0 0 1 14 0M19 8v6M16 11h6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M3 3l18 18M10.6 5.1A9 9 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 4M6.5 6.6A17 17 0 0 0 2 12s4 7 10 7a9 9 0 0 0 4-1M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',
  logout: '<path d="M10 4H5v16h5M16 8l4 4-4 4M20 12H9"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 17-5-5-9 8"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  dash: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  chev: '<path d="m9 5 7 7-7 7"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3z"/>',
  refresh: '<path d="M20 11A8 8 0 0 0 5.5 7M4 4v4h4M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4"/>',
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>',
  vol: '<path d="M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
  megaphone: '<path d="M3 11v3a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1zM15 9a4 4 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/>',
  share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.9 7.6-4.3M8.2 13.1l7.6 4.3"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  clip: '<path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.3 3.3 0 0 1 4.7 4.7L9.2 17.2a1.7 1.7 0 0 1-2.4-2.4L14 7.6"/>',
  mute: '<path d="M4 9v6h4l5 4V5L8 9zM17 9l5 6M22 9l-5 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  checks: '<path d="m2 12.5 4.5 4.5L15 7.5M10 15.5l1.5 1.5L21 7.5"/>',
  reply: '<path d="M9 7 4 12l5 5M4 12h10a6 6 0 0 1 6 6v1"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9.5 2.5h5"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-.9 2-1.8 0-1.4-1.2-1.6-1.2-2.8 0-.9.7-1.4 1.6-1.4H17a4 4 0 0 0 4-4C21 6.7 17 3 12 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7.5" r="1"/><circle cx="14.5" cy="7.5" r="1"/>',
  repost: '<path d="M17 3l4 4-4 4M3 11V9a2 2 0 0 1 2-2h16M7 21l-4-4 4-4M21 13v2a2 2 0 0 1-2 2H3"/>',
  badge: '<path d="M12 3l2.4 2 3.1-.2.9 3 2.6 1.7-1 2.9 1 2.9-2.6 1.7-.9 3-3.1-.2L12 21l-2.4-2-3.1.2-.9-3L3 14.5l1-2.9-1-2.9L5.6 7l.9-3 3.1.2z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  msg: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  contacts: '<rect x="4" y="3" width="15" height="18" rx="2"/><circle cx="11.5" cy="10" r="2.5"/><path d="M7.5 17a4 4 0 0 1 8 0M21 8v3M21 14v3"/>'
};
export const icon = (n, s = 20) => `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${P[n] || ''}</svg>`;

// Badge verified: seal 12-titik electric blue + centang putih (satu komponen untuk semua tempat)
const sealPts = (() => { const a = []; for (let i = 0; i < 24; i++) { const r = i % 2 ? 8.4 : 10.4, t = (Math.PI * 2 * i) / 24; a.push((12 + r * Math.cos(t)).toFixed(2) + ',' + (12 + r * Math.sin(t)).toFixed(2)); } return a.join(' '); })();
export function injectSprite() {
  if (document.getElementById('ov-sprite')) return;
  document.body.insertAdjacentHTML('afterbegin', '<svg id="ov-sprite" width="0" height="0" style="position:absolute" aria-hidden="true"><defs><linearGradient id="ovGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2F73C9"/><stop offset=".6" stop-color="#3F93D6"/><stop offset="1" stop-color="#66B5D6"/></linearGradient></defs></svg>');
}
/* ================= Sistem badge (satu komponen untuk semua halaman) ================= */
const SV = (inner) => (s) => `<svg class="vbadge" width="${s}" height="${s}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${inner}</svg>`;
export const BADGES = {
  official: { n: 'Official', c: '#4B5563', d: 'Ini adalah akun resmi ORVIX.', how: 'Hanya diberikan oleh admin utama ORVIX untuk akun pengumuman, bantuan, dan informasi sistem. Tidak bisa diajukan.',
    svg: SV('<defs><linearGradient id="ovOff" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6B7482"/><stop offset="1" stop-color="#3A414D"/></linearGradient></defs><path d="M12 2.4l8 3v6.1c0 5-3.4 8.4-8 10.1-4.6-1.7-8-5.1-8-10.1V5.4z" fill="url(#ovOff)" stroke="#D5DBE4" stroke-width="1.2" stroke-linejoin="round"/><path d="M12 7.6l1.4 2.8 3 .45-2.2 2.1.55 3L12 14.5l-2.75 1.45.55-3-2.2-2.1 3-.45z" fill="#fff"/>') },
  verified: { n: 'Verified', c: '#1D9BF0', d: 'Identitas akun ini telah diperiksa dan disetujui oleh ORVIX.', how: 'Pengguna mengajukan verifikasi, lalu admin ORVIX memeriksa identitasnya. Badge ini tidak otomatis diberikan kepada akun Creator atau Business.',
    svg: SV(`<polygon points="${sealPts}" fill="url(#ovGrad)" stroke="#66B5D6" stroke-opacity=".5" stroke-width=".6" stroke-linejoin="round"/><path d="m7.8 12.3 2.8 2.8 5.6-6" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>`) },
  business: { n: 'Business', c: '#22D3EE', d: 'Akun bisnis ini telah melalui pemeriksaan ORVIX.', how: 'Pengguna mengajukan verifikasi bisnis dan admin ORVIX memeriksanya. Badge ini berbeda dari Verified dan tidak otomatis memberi Verified.',
    svg: SV('<rect x="2.6" y="2.6" width="18.8" height="18.8" rx="5.4" fill="#22D3EE"/><path d="M7.4 17.4V8.2h5.2v9.2M12.6 11.4h4v6M6.2 17.4h11.6M9.4 10.6h1.2M9.4 13h1.2" fill="none" stroke="#06242B" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>') },
  creator: { n: 'Creator', c: '#8B5CF6', d: 'Pengguna ini telah memenuhi persyaratan program kreator ORVIX.', how: 'Diberikan melalui pengajuan atau program kreator resmi yang disetujui admin. Creator tidak otomatis berarti identitas sudah terverifikasi.',
    svg: SV('<circle cx="12" cy="12" r="9.6" fill="#8B5CF6"/><path d="M12 5.8l1.7 4.5 4.5 1.7-4.5 1.7L12 18.2l-1.7-4.5L5.8 12l4.5-1.7z" fill="#fff"/>') },
  premium: { n: 'ORVIX Premium', c: '#F5B301', d: 'Pengguna ini memiliki langganan ORVIX Premium yang aktif.', how: 'Aktif otomatis selama langganan valid. Badge hilang saat langganan berakhir.',
    svg: SV('<path d="M3.2 18.4l-1-10 5.4 4.3L12 4.8l4.4 7.9 5.4-4.3-1 10z" fill="#F5B301" stroke="#FFE08A" stroke-width="1" stroke-linejoin="round"/><rect x="3.6" y="18.6" width="16.8" height="2.4" rx="1.2" fill="#B97F00"/>') },
};
const BORDER = ['official', 'verified', 'business', 'creator', 'premium'];
const premiumOn = (u) => !!u?.premium_until && new Date(u.premium_until).getTime() > Date.now();
export const badgeKeys = (u) => (!u ? [] : BORDER.filter((k) => (k === 'premium' ? premiumOn(u) : !!u['is_' + k])));
export const BF = new Map();    // id -> {is_verified,is_creator,is_business,is_official,premium_until}
let badgeLoader = null; export const setBadgeLoader = (fn) => { badgeLoader = fn; };
export function badgeHtml(key, s = 16, tap = false, u = null) {
  const b = BADGES[key]; if (!b) return '';
  const until = key === 'premium' && u?.premium_until ? ` data-until="${esc(u.premium_until)}"` : '';
  return tap ? `<span class="vb-t" role="button" tabindex="0" data-binfo="${key}"${until} aria-label="Badge ${b.n}. Ketuk untuk info.">${b.svg(s)}</span>` : `<span class="vb-s" role="img" aria-label="Badge ${b.n}" title="${b.n}">${b.svg(s)}</span>`;
}
export const badgesHtml = (u, s = 16, tap = false) => badgeKeys(u).map((k) => badgeHtml(k, s, tap, u)).join('');
// Kompatibilitas: centang Verified tunggal (dipakai halaman saluran)
export const verifiedBadge = (s = 16, tap = false) => badgeHtml('verified', s, tap);
// v: objek profil (punya kolom badge) atau boolean is_verified dari RPC lama; id: user id agar badge lengkap dimuat otomatis
export function nameWithBadge(n, v, s = 15, tap = false, id = null) {
  const u = v && typeof v === 'object' ? v : (id && BF.get(id)) || (v ? { is_verified: true } : null);
  if (id && v && typeof v === 'object') BF.set(id, v);
  return `<span class="nm"${id ? ` data-bid="${esc(id)}" data-bs="${s}" data-bt="${tap ? 1 : 0}"` : ''}>${esc(n)}<span class="bset">${badgesHtml(u, s, tap)}</span></span>`;
}
// Isi ulang badge di semua nama yang sudah tampil (dipakai setelah data badge dimuat / berubah)
export function hydrateBadges(root = document) {
  root.querySelectorAll('.nm[data-bid]').forEach((el) => {
    const u = BF.get(el.dataset.bid); if (!u) return;
    const set = el.querySelector('.bset'), html = badgesHtml(u, +el.dataset.bs || 15, el.dataset.bt === '1');
    if (set && set.dataset.h !== html) { set.innerHTML = html; set.dataset.h = html; }
  });
}
export async function loadBadges(ids) {
  ids = [...new Set(ids)].filter(Boolean); if (!ids.length || !badgeLoader) return;
  try { (await badgeLoader(ids)).forEach((r) => BF.set(r.id, r)); hydrateBadges(); } catch { /* kolom badge belum ada (SQL 12i belum dijalankan): tampil centang lama */ }
}
if (!window.__ovBadge) {
  window.__ovBadge = 1;
  const vis = () => [...document.querySelectorAll('.nm[data-bid]')].map((e) => e.dataset.bid);
  let t = 0; const queue = () => { clearTimeout(t); t = setTimeout(() => loadBadges(vis().filter((i) => !BF.has(i))), 60); };
  const start = () => { new MutationObserver(queue).observe(document.body, { childList: true, subtree: true }); queue();
    const refresh = () => { if (!document.hidden) loadBadges(vis()); };   // badge dicabut / langganan berakhir tercermin tanpa reload
    setInterval(refresh, 45000); document.addEventListener('visibilitychange', refresh); };
  document.readyState === 'loading' ? addEventListener('DOMContentLoaded', start) : start();
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-binfo]'); if (!b) return; e.preventDefault(); e.stopPropagation();
    const k = b.dataset.binfo, d = BADGES[k]; if (!d) return;
    const extra = k === 'premium' && b.dataset.until ? `<p class="vinfo-x">Aktif hingga ${new Intl.DateTimeFormat('id-ID', { dateStyle: 'long' }).format(new Date(b.dataset.until))}</p>` : '';
    openModal({ title: d.n, sheet: true, html: `<div class="vinfo" style="--bc:${d.c}"><span class="vinfo-ic">${d.svg(56)}</span><span class="vinfo-tag"><i></i>${d.n}</span><p><b>${d.d}</b></p>${extra}<p class="muted">${d.how}</p></div>` });
  }, true);
  document.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-binfo]')) { e.preventDefault(); e.target.click(); } });
}


export function avatar(name, url, size = 44) {
  const ch = esc((name || '?').trim().charAt(0).toUpperCase() || '?');
  const st = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px`;
  return url ? `<span class="av" style="${st}"><img src="${esc(url)}" alt="" loading="lazy" onerror="this.remove()"><b>${ch}</b></span>` : `<span class="av" style="${st}"><b>${ch}</b></span>`;
}

const dtf = (o) => new Intl.DateTimeFormat('id-ID', o);
export const fmtTime = (d) => dtf({ hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(d)).replace('.', ':');
export function fmtDay(d) {
  const x = new Date(d), n = new Date(), y = new Date(); y.setDate(n.getDate() - 1);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(x, n)) return 'Hari ini'; if (same(x, y)) return 'Kemarin';
  return dtf({ day: 'numeric', month: 'long', year: 'numeric' }).format(x);
}
export function listTime(d) {
  const x = new Date(d), n = new Date();
  if (x.toDateString() === n.toDateString()) return fmtTime(x);
  return dtf({ day: '2-digit', month: 'short' }).format(x);
}
export function relTime(d) {
  const s = Math.max(0, (Date.now() - new Date(d)) / 1000);
  if (s < 60) return 'baru saja'; if (s < 3600) return Math.floor(s / 60) + ' menit lalu';
  if (s < 86400) return Math.floor(s / 3600) + ' jam lalu'; return fmtDay(d);
}

export function toast(msg, type = 'info') {
  let box = $('#toasts'); if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.setAttribute('aria-live', 'polite'); document.body.append(box); }
  const t = document.createElement('div'); t.className = 'toast ' + type; t.textContent = msg; box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 250); }, type === 'error' ? 5000 : 3000);
}

export function setBusy(btn, busy, label) {
  if (!btn) return;
  if (busy) { btn.dataset.l = btn.innerHTML; btn.disabled = true; btn.classList.add('busy'); btn.innerHTML = `<span class="spin"></span>${label ? esc(label) : ''}`; }
  else { btn.disabled = false; btn.classList.remove('busy'); if (btn.dataset.l) btn.innerHTML = btn.dataset.l; }
}

// Modal aksesibel: Esc, klik latar, fokus terjaga. Mengembalikan { el, close }.
export function openModal({ title, html = '', onClose, wide = false, sheet = false, cls = '' }) {
  const prev = document.activeElement;
  const back = document.createElement('div'); back.className = 'modal-back' + (sheet ? ' sheet' : '');
  back.innerHTML = `<div class="modal${wide ? ' wide' : ''}${cls ? ' ' + cls : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-h"><h2>${esc(title)}</h2><button class="ibtn" data-x aria-label="Tutup">${icon('x')}</button></div><div class="modal-b">${html}</div></div>`;
  document.body.append(back); document.body.classList.add('noscroll');
  const el = back.querySelector('.modal-b');
  const close = () => { document.removeEventListener('keydown', key); back.remove(); if (!$('.modal-back')) document.body.classList.remove('noscroll'); prev?.focus?.(); onClose?.(); };
  const key = (e) => {
    if (e.key === 'Escape' && back === [...document.querySelectorAll('.modal-back')].pop()) close();
    if (e.key === 'Tab') { const f = $$('button,input,select,textarea,a[href],[tabindex="0"]', back).filter((x) => !x.disabled && x.offsetParent); if (!f.length) return; const a = f[0], b = f[f.length - 1]; if (e.shiftKey && document.activeElement === a) { b.focus(); e.preventDefault(); } else if (!e.shiftKey && document.activeElement === b) { a.focus(); e.preventDefault(); } }
  };
  document.addEventListener('keydown', key);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  back.querySelector('[data-x]').onclick = close;
  setTimeout(() => (el.querySelector('input,textarea,select') || back.querySelector('[data-x]')).focus(), 30);
  return { el, close, root: back };
}

export function confirmDialog({ title, message, confirmText = 'Ya', danger = false }) {
  return new Promise((res) => {
    let done = false;
    const m = openModal({ title, html: `<p class="muted">${message}</p><div class="row end gap"><button class="btn ghost" data-n>Batal</button><button class="btn ${danger ? 'danger' : 'primary'}" data-y>${esc(confirmText)}</button></div>`, onClose: () => { if (!done) res(false); } });
    m.el.querySelector('[data-n]').onclick = () => m.close();
    m.el.querySelector('[data-y]').onclick = () => { done = true; res(true); m.close(); };
  });
}

export async function copyText(t) {
  try { await navigator.clipboard.writeText(t); } catch { const a = document.createElement('textarea'); a.value = t; document.body.append(a); a.select(); try { document.execCommand('copy'); } catch { /* abaikan */ } a.remove(); }
  toast('Tersalin', 'success');
}

export function validateImage(file, maxMB) {
  if (!file) return 'Pilih file terlebih dahulu';
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return 'Format harus JPG, PNG, atau WebP';
  if (file.size > maxMB * 1048576) return `Ukuran maksimal ${maxMB} MB`;
  return null;
}
export const extOf = (f) => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[f.type]);

// Navigasi: sidebar (desktop) + bottom nav (mobile)
const NAV = [['/chat', 'chat', 'Chat'], ['/updates', 'updates', 'Pembaruan'], ['/calls', 'phone', 'Panggilan'], ['/profile', 'user', 'Profil']];
export function navHTML(active, isAdmin = false) {
  const items = NAV.map(([h, i, l]) => `<a href="${h}" class="${h === active ? 'on' : ''}" ${h === active ? 'aria-current="page"' : ''}>${icon(i, 22)}<span>${l}</span></a>`).join('');
  const adm = isAdmin ? `<a href="/admin" class="adm">${icon('shield', 22)}<span>Admin</span></a>` : '';
  return `<aside class="side"><img src="/assets/mark.png" alt="ORVIX" class="side-logo" width="40" height="40"><nav aria-label="Navigasi utama">${items}${adm}</nav></aside><nav class="bottom" aria-label="Navigasi utama">${items}</nav>`;
}
// Navigasi sudah ada statis di HTML (tampil instan); fungsi ini hanya menyinkronkan tautan Admin dan memuat awal halaman lain.
export function mountShell(active, isAdmin = false) {
  injectSprite();
  const nav = $('#nav'); if (!nav) return;
  if (!nav.firstElementChild) nav.innerHTML = navHTML(active, isAdmin);
  else if (isAdmin && !nav.querySelector('a.adm')) nav.querySelectorAll('nav').forEach((n) => n.insertAdjacentHTML('beforeend', `<a href="/admin" class="adm">${icon('shield', 22)}<span>Admin</span></a>`));
  else if (!isAdmin) nav.querySelectorAll('a.adm').forEach((a) => a.remove());
  if (mountShell.pre) return; mountShell.pre = 1;
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 500));
  idle(() => NAV.forEach(([h]) => { if (h === active) return; for (const [rel, href] of [['modulepreload', '/js/' + h.slice(1) + '.js'], ['prefetch', h]]) { const l = document.createElement('link'); l.rel = rel; l.href = href; document.head.append(l); } }));
}


/* ---------- Dropdown kustom: menggantikan popup <select> bawaan browser ---------- */
function ddEnhance(sel) {
  if (sel.dataset.dd || sel.hasAttribute('data-native') || sel.multiple) return; sel.dataset.dd = '1';
  const w = document.createElement('div'); w.className = 'dd'; if (sel.style.width) w.style.width = sel.style.width; if (sel.style.flex) w.style.flex = sel.style.flex;
  sel.before(w); w.append(sel); sel.classList.add('dd-native'); sel.tabIndex = -1;
  const lab = sel.getAttribute('aria-label') || (sel.id && document.querySelector(`label[for="${sel.id}"]`)?.textContent) || 'Pilih opsi';
  const b = document.createElement('button'); b.type = 'button'; b.className = 'inp dd-btn'; b.setAttribute('aria-haspopup', 'listbox'); b.setAttribute('aria-expanded', 'false'); b.setAttribute('aria-label', lab);
  w.prepend(b);
  const sync = () => { const o = sel.options[sel.selectedIndex]; b.innerHTML = `<span class="ell">${esc(o ? o.textContent : '')}</span>${icon('down', 18)}`; b.disabled = sel.disabled; };
  const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(sel, 'value', { get() { return d.get.call(sel); }, set(v) { d.set.call(sel, v); sync(); }, configurable: true });   // sinkron saat kode mengubah value
  sync();
  b.onclick = () => {
    ddClose(); const mobile = matchMedia('(max-width:720px)').matches || matchMedia('(pointer:coarse)').matches;
    const back = document.createElement('div'); back.className = 'dd-back' + (mobile ? ' m' : '');
    const pop = document.createElement('div'); pop.className = 'dd-pop' + (mobile ? ' sheet' : ''); pop.setAttribute('role', 'listbox'); pop.setAttribute('aria-label', lab);
    pop.innerHTML = (mobile ? `<div class="dd-h"><span class="dd-grip"></span><b>${esc(lab)}</b><button type="button" class="ibtn" data-x aria-label="Tutup">${icon('x', 20)}</button></div>` : '') +
      `<div class="dd-list">${[...sel.options].map((o, i) => `<button type="button" role="option" class="dd-o" data-i="${i}" aria-selected="${i === sel.selectedIndex}" ${o.disabled ? 'disabled' : ''}><span class="ell">${esc(o.textContent)}</span><span class="dd-c">${icon('check', 18)}</span></button>`).join('')}</div>`;
    back.append(pop); document.body.append(back); b.setAttribute('aria-expanded', 'true');
    if (!mobile) { const r = b.getBoundingClientRect(), below = innerHeight - r.bottom - 16, up = r.top - 16, flip = below < 200 && up > below; pop.style.minWidth = r.width + 'px'; pop.style.left = Math.max(8, Math.min(r.left, innerWidth - Math.max(r.width, 220) - 8)) + 'px'; pop.style.maxHeight = Math.min(340, flip ? up : below) + 'px'; if (flip) pop.style.bottom = innerHeight - r.top + 6 + 'px'; else pop.style.top = r.bottom + 6 + 'px'; }
    const close = () => { document.removeEventListener('keydown', key, true); removeEventListener('resize', close); back.remove(); b.setAttribute('aria-expanded', 'false'); b.focus?.({ preventScroll: true }); };
    const pick = (i) => { const o = sel.options[i]; if (!o || o.disabled) return; if (sel.selectedIndex !== i) { sel.selectedIndex = i; sync(); sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true })); } close(); };
    const opts = [...pop.querySelectorAll('.dd-o')], cur = opts[sel.selectedIndex] || opts[0];
    const key = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const i = opts.indexOf(document.activeElement); opts[Math.max(0, Math.min(opts.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus(); }
      else if (e.key === 'Tab') { e.preventDefault(); }
    };
    document.addEventListener('keydown', key, true); addEventListener('resize', close);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); }); back.addEventListener('touchstart', (e) => { if (e.target === back) close(); }, { passive: true });
    pop.addEventListener('click', (e) => { if (e.target.closest('[data-x]')) return close(); const o = e.target.closest('[data-i]'); if (o) pick(+o.dataset.i); });
    cur?.focus({ preventScroll: true }); cur?.scrollIntoView({ block: 'center' });
  };
}
function ddClose() { document.querySelectorAll('.dd-back').forEach((e) => e.remove()); }
(() => {
  const scan = (r) => r.querySelectorAll?.('select').forEach(ddEnhance);
  const start = () => { scan(document); new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => { if (n.nodeType === 1) { if (n.tagName === 'SELECT') ddEnhance(n); else scan(n); } }))).observe(document.body, { childList: true, subtree: true }); };
  document.readyState === 'loading' ? addEventListener('DOMContentLoaded', start) : start();
})();

/* ---------- Layar profil penuh (profil teman / info grup) ---------- */
// actions: [{ label, icon, tone: 'quick' | 'danger', run(close) }]
export function profileScreen({ name, username = '', orvixId = '', avatarUrl = null, bannerUrl = null, verified = false, userId = null, bio = '', seen = '', joined = '', group = false, members = [], actions = [], title = '' }) {
  const prev = document.activeElement, quick = actions.filter((a) => a.tone !== 'danger'), danger = actions.filter((a) => a.tone === 'danger');
  const el = document.createElement('div'); el.className = 'pscreen'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', (group ? 'Info grup ' : 'Profil ') + name);
  const row = (k, v, extra = '') => `<div class="ps-row"><span>${k}</span><b>${v}</b>${extra}</div>`;
  const SZ = 116, rowI = (ic, k, v) => `<div class="ps-row"><span class="ps-k">${icon(ic, 18)}${k}</span><b>${v}</b></div>`;
  el.innerHTML = `<header class="ps-top"><button class="ibtn" data-back aria-label="Kembali">${icon('back', 22)}</button><h2>${esc(title || (group ? 'Info grup' : 'Profil'))}</h2></header>
  <div class="ps-scroll"><section class="ps-hero ${bannerUrl ? 'has-banner' : ''}">
    <div class="ps-cover ${bannerUrl ? 'has' : ''}" ${bannerUrl ? 'data-zoomb role="button" tabindex="0" aria-label="Perbesar banner"' : ''}>${bannerUrl ? `<img src="${esc(bannerUrl)}" alt="Banner ${esc(name)}" decoding="async" onload="this.classList.add('in')" onerror="this.parentNode.classList.remove('has');this.remove()">` : `<div class="ps-bg" ${avatarUrl ? `style="background-image:url('${esc(avatarUrl)}')"` : ''}></div>`}</div>
    <div class="ps-id">
      <button class="ps-av ${avatarUrl ? 'has' : ''}" ${avatarUrl ? 'data-zoom' : 'tabindex="-1"'} aria-label="${avatarUrl ? 'Perbesar foto' : 'Avatar'}">${group ? `<span class="av" style="width:${SZ}px;height:${SZ}px">${icon('users', 50)}</span>` : avatar(name, avatarUrl, SZ)}</button>
      <h1>${nameWithBadge(name, verified, 24, true, userId)}</h1>${username ? `<p class="ps-user">@${esc(username)}</p>` : ''}
      <div class="ps-chips">${seen ? `<span class="chip ${/^Online/.test(seen) ? 'live' : ''}"><i></i>${esc(seen)}</span>` : ''}${group ? `<span class="chip">${members.length} anggota</span>` : ''}${orvixId ? `<button class="chip" data-copy="${esc(orvixId)}" aria-label="Salin ID ORVIX">ID ${esc(orvixId)} ${icon('copy', 14)}</button>` : ''}</div>
      ${quick.length ? `<div class="ps-quick">${quick.map((a) => `<button class="qa" data-act="${actions.indexOf(a)}"><span>${icon(a.icon, 20)}</span><small>${esc(a.label)}</small></button>`).join('')}</div>` : ''}
    </div></section>
  ${group ? '' : `<section class="ps-card"><h3>Info</h3><p class="${bio ? '' : 'muted'}">${esc(bio || 'Belum ada info')}</p></section>`}
  ${!group ? `<section class="ps-card"><h3>Detail</h3>${username ? rowI('user', 'Username', '@' + esc(username)) : ''}${orvixId ? rowI('badge', 'ID ORVIX', esc(orvixId)) : ''}${joined ? rowI('clock', 'Bergabung', esc(joined)) : ''}</section>` : ''}
  ${group ? `<section class="ps-card"><h3>Anggota (${members.length})</h3><div class="ps-mem">${members.map((m) => `<div class="row gap">${avatar(m.name, m.avatar, 42)}<span class="grow" style="min-width:0">${nameWithBadge(m.name, m.verified, 15, true, m.id)}<br><span class="dim">${m.username ? '@' + esc(m.username) : ''}</span></span>${m.owner ? '<span class="pill">pemilik</span>' : ''}</div>`).join('')}</div></section>` : ''}
  ${danger.length ? `<section class="ps-card ps-danger">${danger.map((a) => `<button class="ps-d" data-act="${actions.indexOf(a)}">${icon(a.icon, 20)}<span>${esc(a.label)}</span></button>`).join('')}</section>` : ''}</div>`;
  document.body.append(el); document.body.classList.add('noscroll'); history.pushState({ ps: 1 }, '');
  let gone = false;
  const remove = () => { if (gone) return; gone = true; removeEventListener('popstate', onPop); document.removeEventListener('keydown', key); el.classList.add('out'); setTimeout(() => { el.remove(); if (!document.querySelector('.modal-back,.pscreen')) document.body.classList.remove('noscroll'); prev?.focus?.({ preventScroll: true }); }, 180); };
  const close = () => { if (gone) return; if (history.state?.ps) history.back(); else remove(); };
  const onPop = () => remove(); addEventListener('popstate', onPop);
  const key = (e) => { if (e.key === 'Escape' && !document.querySelector('.modal-back') && !document.querySelector('.dd-back')) close(); }; document.addEventListener('keydown', key);
  el.onclick = async (e) => {
    if (e.target.closest('[data-back]')) return close();
    const c = e.target.closest('[data-copy]'); if (c) return copyText(c.dataset.copy);
    const zoomSrc = e.target.closest('[data-zoom]') ? avatarUrl : e.target.closest('[data-zoomb]') ? bannerUrl : null;
    if (zoomSrc) { const d = document.createElement('div'); d.className = 'lbx'; d.innerHTML = `<button class="ibtn" aria-label="Tutup">${icon('x', 22)}</button><img src="${esc(zoomSrc)}" alt="">`; d.onclick = () => d.remove(); document.body.append(d); return; }
    const a = e.target.closest('[data-act]'); if (a) actions[+a.dataset.act]?.run?.(close);
  };
  el.querySelector('[data-back]').focus();
  return { el, close };
}

applyWallpaper();   // dipanggil setelah semua deklarasi (currentTheme dll.) siap
