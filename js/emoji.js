// Emoji gaya iPhone/Apple di seluruh ORVIX (seperti Telegram): teks emoji otomatis ditampilkan sebagai gambar Apple.
// Teks asli tetap tersimpan di database dan di atribut alt, jadi salin-tempel, edit pesan, dan pencarian tidak berubah.
// Gambar dimuat dari paket npm emoji-datasource-apple lewat jsDelivr; bila gambar gagal dimuat, emoji bawaan perangkat dipakai.
const CDN = ['https://cdn.jsdelivr.net/npm/emoji-datasource-apple@15.1.2/img/apple/64/', 'https://cdn.jsdelivr.net/npm/emoji-datasource-apple@15.0.1/img/apple/64/'];
const RE = /(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*[\u{E0020}-\u{E007F}]*)/gu;
const REAL = /\uFE0F|\u20E3|\p{Emoji_Presentation}|\p{Regional_Indicator}|[\u{1F000}-\u{1FFFF}]/u;   // buang simbol teks biasa seperti © ™ ®
const hex = (s) => [...s].map((c) => c.codePointAt(0).toString(16));
// Nama file bisa memakai atau tanpa FE0F; coba beberapa kemungkinan berurutan.
export function emojiCandidates(e) {
  const cps = hex(e), noVs = cps.filter((c) => c !== 'fe0f'), withVs = noVs.length ? [noVs[0], 'fe0f', ...noVs.slice(1)] : noVs;
  const names = [...new Set([cps.join('-'), noVs.join('-'), withVs.join('-')])];
  return CDN.flatMap((b) => names.map((n) => b + n + '.png'));
}
// Pecah teks menjadi potongan {t:'teks'} dan {e:'emoji'}
export function emojiParts(text) {
  const out = []; let last = 0; RE.lastIndex = 0;
  for (const m of text.matchAll(RE)) {
    if (!REAL.test(m[0])) continue;
    if (m.index > last) out.push({ t: text.slice(last, m.index) }); out.push({ e: m[0] }); last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: text.slice(last) }); return out;
}
function makeImg(e) {
  const img = document.createElement('img'), list = emojiCandidates(e); let i = 0;
  img.className = 'emoji'; img.alt = e; img.draggable = false; img.decoding = 'async'; img.dataset.emoji = '1'; img.src = list[0];
  img.onerror = () => { i += 1; if (i < list.length) img.src = list[i]; else img.replaceWith(document.createTextNode(e)); };   // cadangan: emoji bawaan perangkat
  return img;
}
const SKIP = 'INPUT,TEXTAREA,SCRIPT,STYLE,SELECT,OPTION,SVG,TITLE,NOSCRIPT,CODE,PRE';
const skipped = (n) => { for (let p = n.parentElement; p; p = p.parentElement) { if (SKIP.includes(p.tagName.toUpperCase()) && SKIP.split(',').includes(p.tagName.toUpperCase())) return true; if (p.isContentEditable || p.hasAttribute('data-noemoji')) return true; } return false; };
function convert(node) {
  const text = node.nodeValue; if (!text || text.length > 4000 || !RE.test(text)) { RE.lastIndex = 0; return; } RE.lastIndex = 0;
  if (skipped(node)) return;
  const parts = emojiParts(text); if (!parts.some((p) => p.e)) return;
  const f = document.createDocumentFragment(); parts.forEach((p) => f.append(p.e ? makeImg(p.e) : document.createTextNode(p.t))); node.replaceWith(f);
}
function scan(root) {
  if (root.nodeType === 3) return convert(root);
  if (root.nodeType !== 1 || root.dataset?.emoji) return;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), list = []; let n; while ((n = w.nextNode())) list.push(n); list.forEach(convert);
}
if (typeof document !== 'undefined' && !window.__ovEmoji) {
  window.__ovEmoji = 1;
  let queue = new Set(), raf = 0;
  const flush = () => { raf = 0; const q = queue; queue = new Set(); q.forEach((n) => { if (n.isConnected) scan(n); }); };
  const push = (n) => { queue.add(n); if (!raf) raf = requestAnimationFrame(flush); };
  const start = () => { scan(document.body); new MutationObserver((ms) => ms.forEach((m) => { if (m.type === 'characterData') push(m.target); else m.addedNodes.forEach(push); })).observe(document.body, { childList: true, subtree: true, characterData: true }); };
  document.readyState === 'loading' ? addEventListener('DOMContentLoaded', start) : start();
}
