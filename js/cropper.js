// Editor crop gambar: geser, zoom (cubit / roda mouse / slider), lalu hasilkan Blob terkompresi.
// Dipakai untuk foto profil (kotak, tampil bulat) dan banner (3:1). Berjalan sepenuhnya di browser.
import { openModal, icon, toast, esc } from './utils.js';

const MAX_SRC = 25 * 1048576;          // gambar sumber boleh besar; hasil crop selalu dikompres
const MIME = ['image/jpeg', 'image/png', 'image/webp'];

async function decode(file) {
  if (window.createImageBitmap) { try { return await createImageBitmap(file); } catch { /* lanjut ke <img> */ } }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('Gambar tidak bisa dibaca.')); i.src = url; });
    return { width: img.naturalWidth, height: img.naturalHeight, close() {}, _img: img };
  } finally { setTimeout(() => URL.revokeObjectURL(url), 5000); }
}
const src = (b) => b._img || b;

// Kompres canvas sampai <= maxBytes (WebP, turun ke JPEG bila WebP tidak didukung browser).
async function encode(canvas, maxBytes) {
  const tries = [['image/webp', 0.92], ['image/webp', 0.82], ['image/webp', 0.7], ['image/jpeg', 0.8], ['image/jpeg', 0.65], ['image/jpeg', 0.5]];
  let last = null;
  for (const [t, q] of tries) {
    const b = await new Promise((r) => canvas.toBlob(r, t, q));
    if (!b || b.type !== t) continue; last = b; if (b.size <= maxBytes) return b;
  }
  return last && last.size <= maxBytes ? last : null;
}

/**
 * Buka editor crop. Mengembalikan Promise<Blob|null> (null bila dibatalkan).
 * opts: { aspect = 1, outW = 512, round = false, title = 'Potong gambar', maxBytes = 1.9MB, hint = '' }
 */
export async function cropImage(file, opts = {}) {
  const { aspect = 1, outW = 512, round = false, title = 'Potong gambar', maxBytes = 1.9 * 1048576, hint = '' } = opts;
  if (!file || !MIME.includes(file.type)) { toast('Format harus JPG, PNG, atau WebP', 'error'); return null; }
  if (file.size > MAX_SRC) { toast('Gambar terlalu besar (maks. 25 MB)', 'error'); return null; }
  let bmp; try { bmp = await decode(file); } catch (e) { toast(e.message || 'Gambar tidak bisa dibaca.', 'error'); return null; }
  const iw = bmp.width, ih = bmp.height;
  if (!iw || !ih) { toast('Gambar tidak valid', 'error'); return null; }
  const outH = Math.round(outW / aspect);

  return new Promise((resolve) => {
    let done = false, z = 1, cx = iw / 2, cy = ih / 2;   // z=1 berarti gambar pas menutupi bingkai (cover); cx,cy = titik tengah dalam piksel gambar
    const m = openModal({
      title, wide: true, cls: 'crop-modal',
      html: `<div class="crop"><div class="crop-stage ${round ? 'round' : ''}" style="aspect-ratio:${aspect}" role="application" aria-label="Area potong. Seret untuk menggeser, cubit atau gunakan slider untuk zoom."><canvas></canvas><i class="crop-grid" aria-hidden="true"></i></div>
        <p class="crop-hint">${esc(hint || 'Seret untuk menggeser, cubit atau geser slider untuk zoom.')}</p>
        <div class="crop-zoom"><button type="button" class="ibtn" data-z="-" aria-label="Perkecil">${icon('minus', 20)}</button><input type="range" min="1" max="4" step="0.01" value="1" aria-label="Zoom"><button type="button" class="ibtn" data-z="+" aria-label="Perbesar">${icon('plus', 20)}</button></div>
        <div class="row gap end crop-act"><button type="button" class="btn ghost" data-reset>Atur ulang</button><button type="button" class="btn ghost" data-cancel>Batal</button><button type="button" class="btn primary" data-ok>Gunakan</button></div></div>`,
      onClose: () => { bmp.close?.(); if (!done) { done = true; resolve(null); } }
    });
    const stage = m.el.querySelector('.crop-stage'), cv = stage.querySelector('canvas'), ctx = cv.getContext('2d'), rng = m.el.querySelector('input[type=range]');
    const PW = Math.min(outW, 900); cv.width = PW; cv.height = Math.round(PW / aspect);

    const rect = (W, H) => {   // area sumber yang tampak pada bingkai berukuran W×H
      const s = Math.max(W / iw, H / ih) * z, sw = W / s, sh = H / s;
      cx = Math.min(iw - sw / 2, Math.max(sw / 2, cx)); cy = Math.min(ih - sh / 2, Math.max(sh / 2, cy));
      return [cx - sw / 2, cy - sh / 2, sw, sh];
    };
    const draw = (c, W, H) => { const [x, y, w, h] = rect(W, H); c.imageSmoothingQuality = 'high'; c.clearRect(0, 0, W, H); c.drawImage(src(bmp), x, y, w, h, 0, 0, W, H); };
    let raf = 0; const paint = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => draw(ctx, cv.width, cv.height)); };
    const setZ = (v) => { z = Math.min(4, Math.max(1, v)); rng.value = z; paint(); };
    paint();

    // gestur: 1 jari = geser, 2 jari = cubit zoom; roda mouse = zoom
    const pts = new Map(); let lastD = 0;
    stage.addEventListener('pointerdown', (e) => { stage.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); stage.classList.add('drag'); lastD = 0; });
    stage.addEventListener('pointermove', (e) => {
      const p = pts.get(e.pointerId); if (!p) return;
      const r = stage.getBoundingClientRect();
      if (pts.size === 1) {
        const k = (Math.max(r.width / iw, r.height / ih) * z);   // skala tampilan: piksel sumber -> piksel layar
        cx -= (e.clientX - p[0]) / k; cy -= (e.clientY - p[1]) / k; p[0] = e.clientX; p[1] = e.clientY; paint();
      } else if (pts.size === 2) {
        p[0] = e.clientX; p[1] = e.clientY; const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (lastD) setZ(z * (d / lastD)); lastD = d;
      }
    });
    const up = (e) => { pts.delete(e.pointerId); lastD = 0; if (!pts.size) stage.classList.remove('drag'); };
    stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
    stage.addEventListener('wheel', (e) => { e.preventDefault(); setZ(z * (e.deltaY < 0 ? 1.08 : 1 / 1.08)); }, { passive: false });
    stage.tabIndex = 0;
    stage.addEventListener('keydown', (e) => {
      const st = 24 / (Math.max(cv.width / iw, cv.height / ih) * z), map = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, -st], ArrowDown: [0, st] };
      if (map[e.key]) { e.preventDefault(); cx += map[e.key][0]; cy += map[e.key][1]; paint(); } else if (e.key === '+' || e.key === '=') setZ(z * 1.1); else if (e.key === '-') setZ(z / 1.1);
    });
    rng.oninput = () => setZ(+rng.value);
    m.el.querySelectorAll('[data-z]').forEach((b) => (b.onclick = () => setZ(z * (b.dataset.z === '+' ? 1.2 : 1 / 1.2))));
    m.el.querySelector('[data-reset]').onclick = () => { cx = iw / 2; cy = ih / 2; setZ(1); };
    m.el.querySelector('[data-cancel]').onclick = () => m.close();
    m.el.querySelector('[data-ok]').onclick = async (e) => {
      const btn = e.currentTarget; btn.disabled = true; btn.classList.add('busy');
      try {
        const out = document.createElement('canvas'); out.width = outW; out.height = outH;
        const c = out.getContext('2d'); c.imageSmoothingQuality = 'high';
        if (!/image\/png/.test(file.type)) { c.fillStyle = '#000'; c.fillRect(0, 0, outW, outH); }
        draw(c, outW, outH);
        const blob = await encode(out, maxBytes);
        if (!blob) { toast('Hasil crop tidak bisa dikompres di bawah batas ukuran.', 'error'); btn.disabled = false; btn.classList.remove('busy'); return; }
        done = true; resolve(blob); m.close();
      } catch (x) { toast('Gagal memproses gambar.', 'error'); btn.disabled = false; btn.classList.remove('busy'); }
    };
  });
}
