// Pembaruan: story teks / foto / video (24 jam), realtime penuh, tampil instan dari cache.
import { sb, requireAuth, track, fetchProfiles, uploadWithProgress, errMsg } from './supabase.js';
import { mountChannels } from './channels.js';
import { $, $$, esc, icon, avatar, nameWithBadge, relTime, toast, setBusy, openModal, confirmDialog, debounce, mountShell } from './utils.js';

const { profile: me } = await requireAuth({ shell: '/updates' });
mountShell('/updates', me.role === 'admin');
const body = $('#body');
const VIS = { friends: ['Teman', 'users'], public: ['Semua', 'globe'], only_me: ['Hanya saya', 'lock'] };
const DUR = 5000, MAX_IMG = 5 * 1048576, MAX_VID = 25 * 1048576, MAX_SEC = 30, FK = 'orvix:feed:' + me.id;
const VEXT = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' }, IEXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
let extras = new Map();   // id story -> { allow_repost, repost_of, orig_name, orig_username, orig_verified, reposted_by_me }
let feed = [], viewed = new Set(), live = false, viewerOpen = false, viewHook = null, seq = 0, cleaned = false;
const urls = new Map();   // path -> { url, at }
const kindOf = (s) => s.media_type || (s.media_path ? 'image' : null);
const urlOf = (p) => (p ? urls.get(p)?.url : null);
const clock = (ms) => { const t = Math.round((ms || 0) / 1000); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };

/* ---------- cache lokal: tampil instan, lalu disegarkan ---------- */
try {
  const c = JSON.parse(sessionStorage.getItem(FK) || 'null');
  if (c) {
    feed = (c.feed || []).filter((s) => new Date(s.expires_at) > Date.now()); viewed = new Set(feed.filter((s) => s.viewed).map((s) => s.id));
    (c.urls || []).forEach(([k, v]) => { if (Date.now() - v.at < 50 * 60 * 1000) urls.set(k, v); });
  }
} catch { /* abaikan */ }
const save = () => { try { sessionStorage.setItem(FK, JSON.stringify({ feed, urls: [...urls] })); } catch { /* abaikan */ } };

/* ---------- data ---------- */
async function sign(paths) {
  const need = [...new Set(paths)].filter((p) => p && !(urls.get(p) && Date.now() - urls.get(p).at < 50 * 60 * 1000));
  if (!need.length) return false;
  const { data } = await sb.storage.from('stories').createSignedUrls(need, 3600);
  (data || []).forEach((x) => x.signedUrl && urls.set(x.path, { url: x.signedUrl, at: Date.now() }));
  return true;
}
// Gambar dan poster video disiapkan untuk kartu; berkas video baru diminta saat dibuka di penampil.
const cardPaths = (rows) => rows.map((s) => (kindOf(s) === 'video' ? s.thumb_path : s.media_path));
async function fetchFeed() {
  const my = ++seq;
  const { data, error } = await sb.rpc('story_feed');
  if (error) throw error;
  if (my !== seq) return;
  feed = data; viewed = new Set(data.filter((s) => s.viewed).map((s) => s.id));
  try { const { data: ex } = await sb.rpc('orvix_story_extras', { ids: data.map((s) => s.id) }); extras = new Map((ex || []).map((x) => [x.id, x])); } catch { /* fitur repost opsional */ }
  save(); if (!viewerOpen) draw();
  if (await sign(cardPaths(data))) { save(); if (!viewerOpen) draw(); }
  openDeep();
  if (!cleaned) { cleaned = true; cleanupFiles().catch(() => {}); }
}
const refresh = debounce(() => fetchFeed().catch(() => {}), 250);

// Hemat kuota Storage: berkas story milik sendiri yang sudah kedaluwarsa dihapus (berkas < 2 jam tidak disentuh).
async function cleanupFiles() {
  if (sessionStorage.getItem('orvix:clean') === '1') return; sessionStorage.setItem('orvix:clean', '1');
  const keep = new Set(feed.filter((s) => s.user_id === me.id).flatMap((s) => [s.media_path, s.thumb_path]).filter(Boolean));
  const { data } = await sb.storage.from('stories').list(me.id, { limit: 200 });
  const old = (data || []).filter((f) => f.id && f.created_at && Date.now() - new Date(f.created_at) > 2 * 3600e3 && !keep.has(`${me.id}/${f.name}`)).map((f) => `${me.id}/${f.name}`);
  if (old.length) await sb.storage.from('stories').remove(old);
}

let deepDone = false;
function openDeep() {   // tautan dari chat: /updates?story=ID (hanya jika story masih tersedia)
  const id = new URLSearchParams(location.search).get('story'); if (!id || deepDone || viewerOpen) return; deepDone = true; history.replaceState(null, '', '/updates');
  const s = feed.find((x) => x.id === id); if (!s) return toast('Story sudah tidak tersedia', 'error');
  const g = groups().find((x) => x.uid === s.user_id); if (g?.items.length) { openViewer(g, g.items.findIndex((x) => x.id === id)); }
}
function groups() {
  const by = new Map(); feed.forEach((s) => { if (!by.has(s.user_id)) by.set(s.user_id, []); by.get(s.user_id).push(s); });
  const unseen = (g) => (g.items.some((s) => !viewed.has(s.id)) ? 1 : 0), last = (g) => new Date(g.items[g.items.length - 1].created_at);
  const others = [...by].filter(([id]) => id !== me.id).map(([uid, items]) => ({ uid, items, p: { display_name: items[0].display_name, avatar_url: items[0].avatar_url, is_verified: items[0].is_verified } }));
  others.sort((a, b) => unseen(b) - unseen(a) || last(b) - last(a));
  return [{ uid: me.id, items: by.get(me.id) || [], p: me }, ...others];
}

/* ---------- tampilan ---------- */
function thumb(s) {
  const k = kindOf(s);
  if (k === 'image') return urlOf(s.media_path) ? `<img src="${esc(urlOf(s.media_path))}" alt="" decoding="async">` : '<span class="sk"></span>';
  if (k === 'video') return (urlOf(s.thumb_path) ? `<img src="${esc(urlOf(s.thumb_path))}" alt="" decoding="async">` : '<span class="sk"></span>') + `<span class="sc-play" aria-hidden="true">${icon('play', 18)}</span><span class="sc-dur">${clock(s.duration_ms)}</span>`;
  return `<span class="sc-txt">${esc((s.content || '').length > 44 ? s.content.slice(0, 44).trimEnd() + '…' : s.content || '')}</span>`;
}
function card(g, mine) {
  const n = g.items.length, l = g.items[n - 1];
  if (mine && !n) return `<button class="scard add" data-add data-u="${me.id}" role="listitem" aria-label="Tambah story"><span class="add-ic">${icon('plus', 26)}</span><b>Tambah story</b><small>Teks, foto, atau video</small></button>`;
  const seen = mine || g.items.every((s) => viewed.has(s.id));
  return `<button class="scard ${l.media_path ? '' : 'sbg' + l.bg_index} ${seen ? 'seen' : ''}" data-u="${g.uid}" role="listitem" aria-label="${mine ? 'Story saya' : 'Story ' + esc(g.p.display_name)}">${thumb(l)}<span class="sc-shade"></span><span class="sc-av ring ${seen ? 'seen' : ''}">${avatar(g.p.display_name, g.p.avatar_url, 38)}</span>${n > 1 ? `<span class="sc-n">${n}</span>` : ''}${mine ? `<span class="sc-plus" data-add aria-label="Tambah story">${icon('plus', 16)}</span>` : ''}<span class="sc-meta"><b class="ell">${mine ? 'Story saya' : esc(g.p.display_name)}</b><small>${relTime(l.created_at)}</small></span></button>`;
}
function draw() {
  if (!body.isConnected) return;
  const gs = groups(), sl = $('.srail', body)?.scrollLeft || 0, others = gs.slice(1);
  const keep = $('#chan', body);
  body.innerHTML = `<div class="shead"><div><h2>Status</h2><p class="dim">Story hilang otomatis setelah 24 jam</p></div><span class="live ${live ? 'on' : ''}" id="live"><i></i><b>${live ? 'Live' : 'Menyambung…'}</b></span></div>
  <div class="srail" role="list">${card(gs[0], true)}${others.map((g) => card(g, false)).join('')}</div>
  ${others.length ? '' : `<div class="sempty">${icon('updates', 34)}<h3>Belum ada story dari teman</h3><p>Story teman muncul di sini secara langsung, dan hilang setelah 24 jam.</p><a class="btn sm" href="/chat">${icon('userplus', 16)} Cari teman</a></div>`}
  <div id="chan"></div>
  <button class="sfab" id="newS" aria-label="Tambah story">${icon('plus', 26)}</button>`;
  $('.srail', body).scrollLeft = sl;
  if (keep) $('#chan', body).replaceWith(keep);
  mountChannels(me, $('#chan', body));
}
const setLive = (on) => { live = on; const el = $('#live'); if (el) { el.classList.toggle('on', on); el.lastElementChild.textContent = on ? 'Live' : 'Menyambung…'; } };
body.onclick = (e) => {
  if (e.target.closest('[data-add]') || e.target.closest('#newS')) return addStory();
  if (e.target.closest('#rt')) return start();
  const c = e.target.closest('[data-u]'); if (!c) return;
  const g = groups().find((x) => x.uid === c.dataset.u); if (g?.items.length) openViewer(g);
};

/* ---------- penampil story ---------- */
const fs = (t) => (t.length <= 40 ? 32 : t.length <= 90 ? 26 : t.length <= 180 ? 22 : 18);
let muted = false;
function openViewer(g, startAt = -1) {
  viewerOpen = true;
  const items = g.items.slice(), mine = g.uid === me.id, p = g.p;
  let i = startAt >= 0 ? startAt : Math.max(0, items.findIndex((s) => !viewed.has(s.id))), timer = 0, started = 0, left = DUR, paused = false, closed = false, modalOpen = false, holdAt = 0, viewsModal = null, rows = [];
  const v = document.createElement('div'); v.className = 'viewer'; v.setAttribute('role', 'dialog'); v.setAttribute('aria-modal', 'true'); v.setAttribute('aria-label', 'Story');
  document.body.append(v); document.body.classList.add('noscroll');
  const media = () => $('video', v);
  const syncMute = () => { const b = $('[data-mute]', v); if (b) b.innerHTML = icon(muted ? 'mute' : 'vol'); const m = media(); if (m) m.muted = muted; };
  const play = () => {
    clearTimeout(timer); if (closed || modalOpen) return; started = performance.now(); paused = false; v.classList.remove('paused');
    timer = setTimeout(() => go(1), left + (media() ? 2500 : 0));
    const m = media(); if (m) m.play().catch(() => { if (!m.muted) { muted = true; syncMute(); m.play().catch(() => {}); } });
  };
  const pause = () => { if (paused) return; clearTimeout(timer); left = Math.max(0, left - (performance.now() - started)); paused = true; v.classList.add('paused'); media()?.pause(); };
  const close = () => { closed = true; clearTimeout(timer); viewerOpen = false; viewHook = null; media()?.pause(); document.removeEventListener('keydown', key); v.remove(); document.body.classList.remove('noscroll'); draw(); };
  const key = (e) => { if (modalOpen) return; if (e.key === 'Escape') close(); if (e.key === 'ArrowRight') go(1); if (e.key === 'ArrowLeft') go(-1); };
  const go = (d) => { i += d; if (i < 0) i = 0; if (i >= items.length) return close(); show(); };
  document.addEventListener('keydown', key);

  async function loadViews(s) {
    const { data } = await sb.from('story_views').select('viewer_id,viewed_at').eq('story_id', s.id).order('viewed_at', { ascending: false });
    if (closed || items[i] !== s) return; rows = data || [];
    const c = $('#vc', v); if (c) c.textContent = rows.length;
    if (viewsModal) viewsModal(rows);
  }
  function show() {
    const s = items[i], k = kindOf(s), src = urlOf(s.media_path), poster = urlOf(s.thumb_path), ex = extras.get(s.id);
    const dur = k === 'video' ? Math.min(MAX_SEC * 1000, Math.max(1000, s.duration_ms || 15000)) : DUR; left = dur;
    v.className = 'viewer';
    const bg = k === 'video' ? poster : src;
    v.innerHTML = `<div class="stage ${s.media_path ? 'img' : 'sbg' + s.bg_index}">${bg ? `<div class="vblur" style="background-image:url('${esc(bg)}')"></div>` : ''}${k === 'image' && src ? `<img src="${esc(src)}" alt="Gambar story">` : ''}${k === 'video' && src ? `<video class="vvid" src="${esc(src)}" ${poster ? `poster="${esc(poster)}"` : ''} playsinline preload="auto"></video>` : ''}${s.media_path && !src ? '<span class="spin big"></span>' : ''}<div class="vshade"></div>
      <div class="bars">${items.map((_, n) => `<i><b class="${n < i ? 'full' : n === i ? 'run' : ''}" ${n === i ? `style="animation-duration:${dur}ms"` : ''}></b></i>`).join('')}</div>
      <div class="vtop">${avatar(p.display_name, p.avatar_url, 38)}<span class="grow">${nameWithBadge(p.display_name, p.is_verified)}<br><span class="dim">${relTime(s.created_at)}</span>${ex?.repost_of ? `<span class="rp-tag">${icon('repost', 12)} Repost dari ${esc(ex.orig_name || 'pengguna')}${ex.orig_username ? ' (@' + esc(ex.orig_username) + ')' : ''}</span>` : ''}</span>${k === 'video' ? `<button class="ibtn" data-mute aria-label="Suara">${icon(muted ? 'mute' : 'vol')}</button>` : ''}<button class="ibtn" data-close aria-label="Tutup">${icon('x')}</button></div>
      ${s.content ? `<div class="cap ${s.media_path ? 'on-img' : ''}" style="${s.media_path ? '' : 'font-size:' + fs(s.content) + 'px'}">${esc(s.content)}</div>` : ''}
      <button class="vtap l" data-p aria-label="Sebelumnya"></button><button class="vtap r" data-n aria-label="Berikutnya"></button>
      ${!mine ? `<form class="vreply" id="vrf" autocomplete="off"><input class="inp" id="vri" maxlength="1000" placeholder="Balas story…" aria-label="Balas story ${esc(p.display_name)}">${ex?.allow_repost && !ex.reposted_by_me ? `<button type="button" class="ibtn glass" data-repost aria-label="Repost story">${icon('repost', 20)}</button>` : ''}<button class="send" id="vrs" aria-label="Kirim balasan" disabled>${icon('send', 18)}</button></form>` : ''}
      ${mine ? `<div class="vfoot"><button class="btn sm glass" data-views>${icon('eye', 16)} <span id="vc">…</span></button><button class="btn sm glass danger" data-del>${icon('trash', 16)} Hapus</button></div>` : ''}</div>`;
    const stage = $('.stage', v); let y0 = null, dy = 0;
    stage.onpointerdown = (e) => { holdAt = performance.now(); y0 = e.clientY; dy = 0; pause(); };
    stage.onpointermove = (e) => { if (y0 === null) return; dy = Math.max(0, e.clientY - y0); if (dy > 8) { stage.style.transform = `translateY(${dy}px) scale(${1 - dy / 1600})`; stage.style.opacity = 1 - dy / 500; } };
    stage.onpointerup = stage.onpointercancel = () => { if (y0 === null) return; y0 = null; if (dy > 110) return close(); stage.style.transform = ''; stage.style.opacity = ''; play(); };
    $('[data-close]', v).onclick = close;
    $('[data-p]', v).onclick = () => { if (performance.now() - holdAt < 260) go(-1); };
    $('[data-n]', v).onclick = () => { if (performance.now() - holdAt < 260) go(1); };
    const mb = $('[data-mute]', v); if (mb) mb.onclick = (e) => { e.stopPropagation(); muted = !muted; syncMute(); };
    const m = media(); if (m) { m.muted = muted; m.onended = () => go(1); }
    if (s.media_path && !src && !s._t) { s._t = 1; sign([s.media_path, s.thumb_path]).then(() => { if (!closed && items[i] === s) show(); }).catch(() => {}); return; }
    play();
    if (!mine && !viewed.has(s.id)) { viewed.add(s.id); save(); sb.from('story_views').upsert({ story_id: s.id, viewer_id: me.id }, { onConflict: 'story_id,viewer_id', ignoreDuplicates: true }).then(() => {}, () => {}); }
    if (!mine) {
      const vri = $('#vri', v), vrs = $('#vrs', v);
      vri.onfocus = () => { pause(); modalOpen = true; }; vri.onblur = () => { if (!vri.value.trim()) { modalOpen = false; play(); } };
      vri.oninput = () => { vrs.disabled = !vri.value.trim(); };
      $('#vrf', v).onsubmit = async (e) => {
        e.preventDefault(); const t = vri.value.trim(); if (!t) return; vrs.disabled = true; vri.disabled = true;
        const { error } = await sb.rpc('orvix_reply_story', { p_story: s.id, p_text: t });
        vri.disabled = false; if (error) { vrs.disabled = false; return toast(errMsg(error), 'error'); }
        vri.value = ''; vri.blur(); modalOpen = false; toast('Balasan terkirim ke chat', 'success'); play();
      };
      const rb = $('[data-repost]', v);
      if (rb) rb.onclick = async () => {
        pause(); modalOpen = true;
        const m3 = openModal({ title: 'Repost story', sheet: true, html: `<p class="muted" style="margin-bottom:10px">Story ini akan tampil di akunmu dengan atribusi ke <b>${esc(p.display_name)}</b> dan hilang saat story aslinya hilang. Pilih siapa yang bisa melihat repostmu.</p><div class="col">${Object.entries(VIS).map(([k, [l]]) => `<button class="btn" data-rv="${k}">${l}</button>`).join('')}</div>`, onClose: () => { modalOpen = false; play(); } });
        m3.el.onclick = async (e) => {
          const b = e.target.closest('[data-rv]'); if (!b) return; setBusy(b, true);
          const { error } = await sb.rpc('orvix_repost_story', { p_story: s.id, p_visibility: b.dataset.rv });
          if (error) { setBusy(b, false); return toast(errMsg(error), 'error'); }
          const x = extras.get(s.id); if (x) x.reposted_by_me = true; rb.remove(); m3.close(); toast('Story direpost', 'success'); fetchFeed().catch(() => {});
        };
      };
    }
    if (mine) {
      loadViews(s); viewHook = (r) => { if (r.story_id === items[i]?.id) loadViews(items[i]); };
      $('[data-views]', v).onclick = () => {
        pause(); modalOpen = true;
        const render = async (list) => {
          const pm = await fetchProfiles(list.map((r) => r.viewer_id)); if (!m2.el.isConnected) return;
          m2.el.innerHTML = list.length ? `<div class="col" style="gap:6px">${list.map((r) => { const q = pm.get(r.viewer_id) || { display_name: 'Pengguna' }; return `<div class="vrow">${avatar(q.display_name, q.avatar_url, 40)}<span class="grow">${nameWithBadge(q.display_name, q.is_verified)}</span><span class="dim">${relTime(r.viewed_at)}</span></div>`; }).join('')}</div>` : '<p class="muted" style="padding:8px 0 14px">Belum ada yang melihat.</p>';
        };
        const m2 = openModal({ title: 'Dilihat oleh', sheet: true, cls: 'vlist', html: '', onClose: () => { modalOpen = false; viewsModal = null; play(); } });
        viewsModal = render; render(rows);
      };
      $('[data-del]', v).onclick = async () => {
        pause(); modalOpen = true;
        const ok = await confirmDialog({ title: 'Hapus story?', message: 'Story ini akan dihapus untuk semua orang.', confirmText: 'Hapus', danger: true });
        modalOpen = false; if (!ok) return play();
        const files = [s.media_path, s.thumb_path].filter(Boolean); if (files.length) await sb.storage.from('stories').remove(files);
        const { error } = await sb.from('stories').delete().eq('id', s.id); if (error) { toast(errMsg(error), 'error'); return play(); }
        feed = feed.filter((x) => x.id !== s.id); save(); items.splice(i, 1);
        if (!items.length) return close(); if (i >= items.length) i = items.length - 1; show();
      };
    }
  }
  show();
}

/* ---------- tambah story ---------- */
async function compressImage(file) {
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return file.size <= MAX_IMG ? file : null;
  const k = Math.min(1, 1440 / Math.max(bmp.width, bmp.height));
  if (k === 1 && file.size <= 1.5 * 1048576) { bmp.close?.(); return file; }
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
  for (const [type, q] of [['image/webp', 0.85], ['image/jpeg', 0.85], ['image/jpeg', 0.65]]) {
    const b = await new Promise((r) => c.toBlob(r, type, q));
    if (b && b.type === type && b.size <= MAX_IMG) return b;
  }
  return null;
}
// Validasi video: format, ukuran (batas Free Plan: berkas maks. 25 MB di bucket), durasi (maks. 30 detik), dan poster.
async function probeVideo(file) {
  if (!VEXT[file.type]) throw new Error('Format video harus MP4, WebM, atau MOV.');
  if (file.size > MAX_VID) throw new Error('Ukuran video maksimal 25 MB.');
  const url = URL.createObjectURL(file), el = document.createElement('video');
  el.muted = true; el.playsInline = true; el.preload = 'metadata'; el.src = url;
  try {
    await new Promise((res, rej) => { el.onloadedmetadata = res; el.onerror = () => rej(new Error('Video tidak bisa diputar di browser ini. Coba video MP4.')); setTimeout(() => rej(new Error('Video terlalu lama dimuat.')), 15000); });
    const dur = el.duration;
    if (!Number.isFinite(dur) || dur < 1) throw new Error('Durasi video tidak valid.');
    if (dur > MAX_SEC + 0.5) throw new Error(`Durasi video maksimal ${MAX_SEC} detik.`);
    el.currentTime = Math.min(0.5, dur / 2); await new Promise((r) => { el.onseeked = r; setTimeout(r, 4000); });
    const k = Math.min(1, 540 / Math.max(el.videoWidth || 540, el.videoHeight || 540)), c = document.createElement('canvas');
    c.width = Math.max(2, Math.round((el.videoWidth || 540) * k)); c.height = Math.max(2, Math.round((el.videoHeight || 540) * k));
    c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
    const thumb = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
    return { file, url, dur, thumb };
  } catch (e) { URL.revokeObjectURL(url); throw e; }
}
function addStory() {
  let mode = 'text', bg = 0, img = null, vid = null, imgUrl = null, busy = false, vis = me.story_visibility in VIS ? me.story_visibility : 'friends';
  const MODES = ['text', 'image', 'video'];
  const m = openModal({ title: 'Tambah story', sheet: true, cls: 'scmp', html: `<div class="cmp">
    <div class="seg" style="--i:0" role="tablist"><i class="seg-ind"></i><button type="button" data-m="text" role="tab" aria-selected="true">Teks</button><button type="button" data-m="image" role="tab" aria-selected="false">Foto</button><button type="button" data-m="video" role="tab" aria-selected="false">Video</button></div>
    <div class="cmp-prev sbg0" id="pv"><div class="pv-text" id="pvt"></div><img id="pvi" class="hide" alt="Pratinjau"><video id="pvv" class="hide" muted loop autoplay playsinline></video><span class="pv-dur hide" id="pvd"></span>
      <label class="drop hide" id="drop" for="sfile">${icon('image', 30)}<b id="dropt">Pilih foto</b><small id="drops"></small></label><button type="button" class="pv-rm hide" id="rm" aria-label="Ganti file">${icon('x', 16)}</button></div>
    <input type="file" id="sfile" hidden>
    <div class="swatches" id="tx" role="group" aria-label="Warna latar">${[0, 1, 2, 3, 4, 5].map((k) => `<button type="button" class="sbg${k}" data-bg="${k}" aria-pressed="${k === 0}" aria-label="Latar ${k + 1}"></button>`).join('')}</div>
    <div class="tarea"><textarea class="inp" id="sc" maxlength="500" placeholder="Tulis sesuatu untuk story…" aria-label="Teks story"></textarea><span class="cnt" id="cnt">0/500</span></div>
    <p class="hint" style="margin:10px 2px 6px">Siapa yang bisa melihat</p>
    <div class="vis" role="radiogroup" aria-label="Siapa yang bisa melihat">${Object.entries(VIS).map(([k, [l, ic]]) => `<button type="button" role="radio" data-v="${k}" aria-checked="${k === vis}">${icon(ic, 20)}<span>${l}</span></button>`).join('')}</div>
    <label class="rpt" id="rptw"><input type="checkbox" id="rpt"><span><b>Izinkan repost</b><small>Hanya untuk story “Semua”. Pengguna lain dapat membagikannya ulang dengan atribusi ke kamu.</small></span></label>
    <div class="upl hide" id="upl"><div class="upl-bar"><i id="upb"></i></div><span id="upt">Mengunggah…</span></div>
    <p class="err" id="er" role="alert"></p><button class="btn primary block" id="go" disabled>Bagikan story</button></div>`,
  onClose: () => { if (imgUrl) URL.revokeObjectURL(imgUrl); if (vid) URL.revokeObjectURL(vid.url); } });
  const el = m.el, pv = $('#pv', el), pvt = $('#pvt', el), pvi = $('#pvi', el), pvv = $('#pvv', el), sc = $('#sc', el), go = $('#go', el), er = $('#er', el), fileIn = $('#sfile', el);
  const has = () => (mode === 'image' ? img : mode === 'video' ? vid : null);
  const sync = () => {
    const t = sc.value.trim(), picked = !!has(); $('#cnt', el).textContent = sc.value.length + '/500';
    pv.className = 'cmp-prev ' + (mode === 'text' ? 'sbg' + bg : 'sbg1');
    pvt.textContent = mode === 'text' ? (sc.value || 'Ketik sesuatu…') : sc.value; pvt.style.fontSize = fs(sc.value || 'x') * 0.62 + 'px';
    pvt.classList.toggle('ph', mode === 'text' && !sc.value); pvt.classList.toggle('cap-on', mode !== 'text' && !!sc.value);
    $('#tx', el).classList.toggle('hide', mode !== 'text'); $('#drop', el).classList.toggle('hide', mode === 'text' || picked);
    pvi.classList.toggle('hide', mode !== 'image' || !img); pvv.classList.toggle('hide', mode !== 'video' || !vid);
    $('#rm', el).classList.toggle('hide', !picked || busy); $('#pvd', el).classList.toggle('hide', mode !== 'video' || !vid);
    if (mode === 'video' && vid) { pvv.play?.().catch(() => {}); $('#pvd', el).textContent = clock(vid.dur * 1000); } else pvv.pause?.();
    $('#dropt', el).textContent = mode === 'video' ? 'Pilih video' : 'Pilih foto';
    $('#drops', el).textContent = mode === 'video' ? 'MP4, WebM, atau MOV. Maks. 30 detik dan 25 MB.' : 'JPG, PNG, atau WebP. Dikompres otomatis.';
    fileIn.accept = mode === 'video' ? 'video/mp4,video/webm,video/quicktime' : 'image/jpeg,image/png,image/webp';
    sc.placeholder = mode === 'text' ? 'Tulis sesuatu untuk story…' : 'Tambahkan keterangan (opsional)';
    go.disabled = busy || (mode === 'text' ? !t : !picked);
  };
  $$('[data-m]', el).forEach((b) => b.onclick = () => {
    if (busy) return; mode = b.dataset.m; $('.seg', el).style.setProperty('--i', MODES.indexOf(mode)); er.textContent = '';
    $$('[data-m]', el).forEach((x) => x.setAttribute('aria-selected', x === b)); sync();
  });
  $$('[data-bg]', el).forEach((b) => b.onclick = () => { bg = +b.dataset.bg; $$('[data-bg]', el).forEach((x) => x.setAttribute('aria-pressed', x === b)); sync(); });
  const syncRpt = () => { const w = $('#rptw', el), c = $('#rpt', el); w.classList.toggle('off', vis !== 'public'); c.disabled = vis !== 'public'; if (vis !== 'public') c.checked = false; };
  $$('[data-v]', el).forEach((b) => b.onclick = () => { vis = b.dataset.v; $$('[data-v]', el).forEach((x) => x.setAttribute('aria-checked', x === b)); syncRpt(); });
  syncRpt();
  $('#rm', el).onclick = () => {
    if (mode === 'image') { img = null; if (imgUrl) URL.revokeObjectURL(imgUrl); imgUrl = null; pvi.removeAttribute('src'); }
    if (mode === 'video') { if (vid) URL.revokeObjectURL(vid.url); vid = null; pvv.removeAttribute('src'); pvv.load(); }
    er.textContent = ''; sync();
  };
  sc.oninput = sync;
  fileIn.onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ''; er.textContent = ''; if (!f) return;
    go.disabled = true;
    try {
      if (mode === 'image') {
        if (!IEXT[f.type]) throw new Error('Format harus JPG, PNG, atau WebP.');
        if (f.size > 25 * 1048576) throw new Error('Ukuran foto terlalu besar (maks. 25 MB).');
        const out = await compressImage(f); if (!out) throw new Error('Foto tidak bisa diperkecil di bawah 5 MB. Coba foto lain.');
        img = out; if (imgUrl) URL.revokeObjectURL(imgUrl); imgUrl = URL.createObjectURL(img); pvi.src = imgUrl;
      } else {
        const probe = await probeVideo(f); if (vid) URL.revokeObjectURL(vid.url); vid = probe; pvv.src = vid.url;
      }
    } catch (x) { er.textContent = x.message; }
    sync();
  };
  const progress = (frac, label) => { $('#upb', el).style.width = Math.round(frac * 100) + '%'; $('#upt', el).textContent = `${label} ${Math.round(frac * 100)}%`; };
  go.onclick = async () => {
    const txt = sc.value.trim(); er.textContent = ''; if (go.disabled) return;
    busy = true; setBusy(go, true, mode === 'text' ? 'Membagikan…' : 'Mengunggah…'); $('#upl', el).classList.toggle('hide', mode === 'text'); progress(0, 'Mengunggah'); sync(); go.disabled = true;
    const files = []; let row = { user_id: me.id, content: txt || null, media_path: null, bg_index: mode === 'text' ? bg : 0, visibility: vis, allow_repost: vis === 'public' && $('#rpt', el).checked };
    try {
      if (mode === 'image') {
        const path = `${me.id}/${crypto.randomUUID()}.${extOf(img.type)}`; files.push(path);
        const up = await uploadWithProgress('stories', path, img, (f) => progress(f, 'Mengunggah foto')); if (up.error) throw up.error;
        row = { ...row, media_path: path, media_type: 'image' };
      } else if (mode === 'video') {
        const id = crypto.randomUUID(), path = `${me.id}/${id}.${VEXT[vid.file.type]}`, tpath = `${me.id}/${id}_t.jpg`; files.push(path);
        const up = await uploadWithProgress('stories', path, vid.file, (f) => progress(f * 0.95, 'Mengunggah video')); if (up.error) throw up.error;
        if (vid.thumb) { files.push(tpath); const ut = await uploadWithProgress('stories', tpath, vid.thumb); if (ut.error) throw ut.error; }
        progress(1, 'Menyelesaikan');
        row = { ...row, media_path: path, media_type: 'video', thumb_path: vid.thumb ? tpath : null, duration_ms: Math.min(60000, Math.max(1000, Math.round(vid.dur * 1000))) };
      }
      const { error } = await sb.from('stories').insert(row);
      if (error) throw error;
      m.close(); toast('Story dibagikan', 'success'); fetchFeed().catch(() => {});
    } catch (x) {
      if (files.length) sb.storage.from('stories').remove(files).catch(() => {});
      busy = false; setBusy(go, false); $('#upl', el).classList.add('hide'); er.textContent = errMsg(x); sync();
    }
  };
  sync();
}
const extOf = (type) => IEXT[type] || 'jpg';

/* ---------- realtime ---------- */
track(sb.channel('story-' + me.id)
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'stories' }, refresh)
  .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'stories' }, (e) => { const id = e.old?.id; if (id && feed.some((s) => s.id === id)) { feed = feed.filter((s) => s.id !== id); save(); if (!viewerOpen) draw(); } })
  .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, refresh)
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'story_views' }, (e) => viewHook?.(e.new))
  .subscribe((st) => { setLive(st === 'SUBSCRIBED'); if (st === 'SUBSCRIBED') refresh(); }));
setInterval(() => { const n = feed.length; feed = feed.filter((s) => new Date(s.expires_at) > Date.now()); if (feed.length !== n && !viewerOpen) draw(); }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
addEventListener('online', refresh);

/* ---------- mulai ---------- */
function start() {
  fetchFeed().catch((e) => { if (!feed.length) body.innerHTML = `<div class="empty"><h3>Gagal memuat pembaruan</h3><p>${esc(errMsg(e))}</p><button class="btn" id="rt" style="margin-top:12px">Coba lagi</button></div>`; });
}
draw();
sign(cardPaths(feed)).then((c) => c && !viewerOpen && draw()).catch(() => {});
start();
