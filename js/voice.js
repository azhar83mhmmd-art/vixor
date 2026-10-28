// Pesan suara: perekam (MediaRecorder + analyser gelombang) dan pemutar (satu audio global, kecepatan 1×/1.5×/2×, geser untuk mencari).
import { signedUrl, fmtDur } from './media.js';

const BARS = 40;
const MIMES = [['audio/webm;codecs=opus', 'audio/webm', 'webm'], ['audio/ogg;codecs=opus', 'audio/ogg', 'ogg'], ['audio/mp4', 'audio/mp4', 'm4a'], ['audio/webm', 'audio/webm', 'webm']];
export const voiceSupported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder && isSecureContext);
const pickMime = () => MIMES.find(([t]) => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) || [null, 'audio/webm', 'webm'];

const b36 = (n) => Math.max(0, Math.min(35, n | 0)).toString(36);
function squash(peaks) {   // ringkas ke BARS batang (0..35), dinormalisasi
  if (!peaks.length) return '0'.repeat(BARS).replace(/0/g, '3');
  const out = [], step = peaks.length / BARS;
  for (let i = 0; i < BARS; i++) { let m = 0; for (let j = Math.floor(i * step); j < Math.max(Math.floor(i * step) + 1, Math.floor((i + 1) * step)) && j < peaks.length; j++) m = Math.max(m, peaks[j]); out.push(m); }
  const top = Math.max(0.05, ...out); return out.map((v) => b36(Math.pow(v / top, 0.7) * 35)).join('');
}

export class Recorder {
  constructor(onLevel) { this.onLevel = onLevel; this.chunks = []; this.peaks = []; this.t0 = 0; this.acc = 0; this.state = 'idle'; }
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const [type, mime, ext] = pickMime(); this.mime = mime; this.ext = ext;
    this.rec = new MediaRecorder(this.stream, type ? { mimeType: type } : undefined);
    this.rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); const src = this.ctx.createMediaStreamSource(this.stream); this.an = this.ctx.createAnalyser(); this.an.fftSize = 512; src.connect(this.an); this.buf = new Uint8Array(this.an.fftSize); } catch { this.an = null; }
    this.rec.start(250); this.t0 = performance.now(); this.state = 'rec';
    this.tick = setInterval(() => {
      if (this.state !== 'rec' || !this.an) return; this.an.getByteTimeDomainData(this.buf);
      let m = 0; for (const v of this.buf) m = Math.max(m, Math.abs(v - 128)); const lv = m / 128; this.peaks.push(lv); this.onLevel && this.onLevel(lv);
    }, 80);
  }
  get elapsed() { return this.acc + (this.state === 'rec' ? performance.now() - this.t0 : 0); }
  pause() { if (this.state !== 'rec') return; try { this.rec.pause(); } catch { return; } this.acc += performance.now() - this.t0; this.state = 'paused'; }
  resume() { if (this.state !== 'paused') return; try { this.rec.resume(); } catch { return; } this.t0 = performance.now(); this.state = 'rec'; }
  _free() { clearInterval(this.tick); try { this.stream && this.stream.getTracks().forEach((t) => t.stop()); } catch { /* abaikan */ } try { this.ctx && this.ctx.close(); } catch { /* abaikan */ } }
  cancel() { this.state = 'idle'; try { this.rec && this.rec.state !== 'inactive' && this.rec.stop(); } catch { /* abaikan */ } this._free(); this.chunks = []; }
  async stop() {
    if (this.state === 'idle') return null; const dur = this.elapsed;
    const done = new Promise((r) => { this.rec.onstop = r; }); try { this.rec.state !== 'inactive' && this.rec.stop(); } catch { /* abaikan */ }
    this.state = 'idle'; await done; this._free();
    const blob = new Blob(this.chunks, { type: this.mime }); this.chunks = [];
    return { blob, ext: this.ext, mime: this.mime, duration_ms: dur, wave: squash(this.peaks) };
  }
}

/* ---------- pemutar ---------- */
const audio = new Audio(); audio.preload = 'auto';
let cur = null, rate = 1;   // cur = { id, el }
const hashWave = (id) => { let h = 7; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return Array.from({ length: BARS }, (_, i) => b36(6 + ((h >> (i % 24)) ^ (i * 7)) % 22)).join(''); };
export function paintBars(el) {
  const holder = el.querySelector('[data-vn-bars]'); if (!holder || holder.childElementCount) return;
  const w = (el.dataset.wave && el.dataset.wave.length >= 8 ? el.dataset.wave : hashWave(el.dataset.id)).split('');
  holder.innerHTML = w.map((c) => `<i style="height:${18 + (parseInt(c, 36) || 0) * 2.2}%"></i>`).join('');
}
function setPlaying(el, on) { if (!el) return; el.classList.toggle('playing', on); const b = el.querySelector('[data-vn-play]'); if (b) b.setAttribute('aria-label', on ? 'Jeda pesan suara' : 'Putar pesan suara'); }
function setProgress(el, f) {
  if (!el) return; const bars = el.querySelectorAll('[data-vn-bars] i'), n = Math.round(bars.length * f);
  bars.forEach((b, i) => b.classList.toggle('on', i < n));
  const t = el.querySelector('.vn-time'); if (t) { const dur = +el.dataset.dur || (audio.duration * 1000) || 0; t.textContent = f > 0 && f < 1 ? fmtDur(dur * f) + ' / ' + fmtDur(dur) : fmtDur(dur); }
}
audio.ontimeupdate = () => { if (cur && audio.duration) setProgress(cur.el, audio.currentTime / audio.duration); };
audio.onended = () => { if (cur) { setPlaying(cur.el, false); setProgress(cur.el, 0); } cur = null; };
audio.onpause = () => { if (cur && !audio.ended) setPlaying(cur.el, false); };
audio.onplay = () => { if (cur) setPlaying(cur.el, true); };
export function stopVoice() { try { audio.pause(); } catch { /* abaikan */ } if (cur) { setPlaying(cur.el, false); setProgress(cur.el, 0); } cur = null; }
// Setelah daftar pesan dirender ulang, pasang kembali status pemutaran pada elemen baru.
export function syncVoice(root) {
  root.querySelectorAll('.vn').forEach(paintBars); root.querySelectorAll('[data-vn-spd]').forEach((b) => { b.textContent = rate + '×'; });
  if (!cur) return; const el = root.querySelector(`.vn[data-id="${CSS.escape(cur.id)}"]`); if (!el) return; cur.el = el; setPlaying(el, !audio.paused); setProgress(el, audio.duration ? audio.currentTime / audio.duration : 0);
}
async function toggle(el) {
  const id = el.dataset.id;
  if (cur && cur.id === id) { audio.paused ? audio.play().catch(() => {}) : audio.pause(); return; }
  stopVoice(); cur = { id, el };
  let src = el.dataset.src; if (!src) { src = await signedUrl(el.dataset.mp); if (src) el.dataset.src = src; }
  if (!src) { cur = null; return; }
  audio.src = src; audio.playbackRate = rate; try { await audio.play(); } catch { setPlaying(el, false); cur = null; }
}
export function bindPlayer(root) {
  root.addEventListener('click', (e) => {
    const play = e.target.closest('[data-vn-play]'), spd = e.target.closest('[data-vn-spd]'), bars = e.target.closest('[data-vn-bars]');
    const el = e.target.closest('.vn'); if (!el) return;
    if (play) { e.stopPropagation(); toggle(el); }
    else if (spd) { e.stopPropagation(); rate = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1; audio.playbackRate = rate; root.querySelectorAll('[data-vn-spd]').forEach((b) => { b.textContent = rate + '×'; }); }
    else if (bars && cur && cur.id === el.dataset.id && audio.duration) { e.stopPropagation(); const r = bars.getBoundingClientRect(); audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * audio.duration; }
  }, true);
}
