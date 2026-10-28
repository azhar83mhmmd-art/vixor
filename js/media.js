// Media pesan (foto/video) untuk chat, grup, dan saluran: validasi, kompres, unggah, URL bertanda tangan.
import { sb, uploadWithProgress } from './supabase.js';
import { esc, icon } from './utils.js';

const IEXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }, VEXT = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };
export const ACCEPT = Object.keys({ ...IEXT, ...VEXT }).join(','), MAX_IMG = 5 * 1048576, MAX_VID = 25 * 1048576;
export const isPlaceholder = (m) => m.media_path && (m.content === '📷 Foto' || m.content === '🎥 Video' || m.content === '🎤 Pesan suara');

async function shrink(file) {
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return file.size <= MAX_IMG ? file : null;
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  if (k === 1 && file.size <= 1.5 * 1048576) { bmp.close?.(); return file; }
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
  for (const [t, q] of [['image/webp', 0.85], ['image/jpeg', 0.8], ['image/jpeg', 0.6]]) {
    const b = await new Promise((r) => c.toBlob(r, t, q)); if (b && b.type === t && b.size <= MAX_IMG) return b;
  }
  return null;
}
async function prepare(file) {
  if (IEXT[file.type]) {
    if (file.size > 25 * 1048576) throw new Error('Foto terlalu besar (maks. 25 MB).');
    const b = await shrink(file); if (!b) throw new Error('Foto tidak bisa diperkecil di bawah 5 MB.');
    return { blob: b, type: 'image', ext: IEXT[b.type] || 'jpg' };
  }
  if (VEXT[file.type]) {
    if (file.size > MAX_VID) throw new Error('Ukuran video maksimal 25 MB.');
    return { blob: file, type: 'video', ext: VEXT[file.type] };
  }
  throw new Error('Format harus JPG, PNG, WebP, MP4, WebM, atau MOV.');
}

// Kirim pesan teks atau media ke percakapan (grup/chat pribadi/saluran). Melempar Error bila gagal.
export async function sendMessage({ conv, me, text = '', file = null, onProgress, replyTo = null, audio = null }) {
  let row = { conversation_id: conv, sender_id: me, content: text.trim(), message_type: 'text' };
  if (replyTo && !String(replyTo).startsWith('tmp-')) row.reply_to = replyTo;
  if (audio) {   // pesan suara: { blob, ext, mime, duration_ms, wave }
    const path = `${conv}/${me}/${crypto.randomUUID()}.${audio.ext}`, blob = new Blob([audio.blob], { type: audio.mime });
    const up = await uploadWithProgress('chat-media', path, blob, onProgress); if (up.error) throw up.error;
    row = { ...row, content: '🎤 Pesan suara', message_type: 'audio', media_type: 'audio', media_path: path, duration_ms: Math.max(500, Math.min(600000, Math.round(audio.duration_ms))), wave: audio.wave || null };
  } else if (file) {
    const p = await prepare(file), path = `${conv}/${me}/${crypto.randomUUID()}.${p.ext}`;
    const up = await uploadWithProgress('chat-media', path, p.blob, onProgress); if (up.error) throw up.error;
    row = { ...row, content: row.content || (p.type === 'image' ? '📷 Foto' : '🎥 Video'), message_type: p.type, media_type: p.type, media_path: path };
  }
  const { data, error } = await sb.from('messages').insert(row).select().single();
  if (error) { if (row.media_path) sb.storage.from('chat-media').remove([row.media_path]).catch(() => {}); throw error; }
  return data;
}
export const removeMedia = (m) => (m.media_path ? sb.storage.from('chat-media').remove([m.media_path]).catch(() => {}) : null);

// URL bertanda tangan (cache 50 menit)
const urls = new Map();
async function sign(paths) {
  const need = [...new Set(paths)].filter((p) => !(urls.get(p) && Date.now() - urls.get(p).at < 3000000)); if (!need.length) return;
  const { data } = await sb.storage.from('chat-media').createSignedUrls(need, 3600);
  (data || []).forEach((x) => x.signedUrl && urls.set(x.path, { url: x.signedUrl, at: Date.now() }));
}
const fmtDur = (ms) => { const t = Math.round((ms || 0) / 1000); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
export const mediaHTML = (m) => {
  if (!m.media_path) return '';
  if (m.media_type === 'audio') return `<div class="vn" data-mp="${esc(m.media_path)}" data-mt="audio" data-dur="${m.duration_ms || 0}" data-wave="${esc(m.wave || '')}" data-id="${esc(m.id)}"><button type="button" class="vn-play" data-vn-play aria-label="Putar pesan suara"></button><span class="vn-bars" data-vn-bars></span><span class="vn-side"><span class="vn-time">${fmtDur(m.duration_ms)}</span><button type="button" class="vn-spd" data-vn-spd aria-label="Kecepatan putar">1×</button></span></div>`;
  return `<div class="mm" data-mp="${esc(m.media_path)}" data-mt="${m.media_type}"><span class="sk"></span></div>`;
};
export async function hydrate(root) {
  const els = [...root.querySelectorAll('.mm[data-mp]:not([data-ok]), .vn[data-mp]:not([data-ok])')]; if (!els.length) return;
  await sign(els.map((e) => e.dataset.mp));
  els.forEach((e) => {
    const u = urls.get(e.dataset.mp)?.url; if (!u) return; e.dataset.ok = 1;
    if (e.classList.contains('vn')) { e.dataset.src = u; return; }
    e.innerHTML = e.dataset.mt === 'video' ? `<video src="${esc(u)}" controls playsinline preload="metadata"></video>` : `<img src="${esc(u)}" alt="Foto" loading="lazy">`;
  });
}
export function lightbox(src) {
  const d = document.createElement('div'); d.className = 'lbx'; d.innerHTML = `<button class="ibtn" aria-label="Tutup">${icon('x', 22)}</button><img src="${esc(src)}" alt="">`;
  d.onclick = () => d.remove(); document.body.append(d);
}

// URL bertanda tangan untuk satu berkas (dipakai teruskan/unduh)
export async function signedUrl(path) { await sign([path]); return urls.get(path)?.url || null; }
export { fmtDur };
