// Saluran (ala WhatsApp): ikuti, jelajahi rekomendasi buatan pengguna (real-time), profil saluran, buat/ubah/hapus.
// Hanya pemilik yang bisa mengirim. Daftar hanya digambar ulang bila isinya berubah, dan tidak saat jari menyentuh layar.
import { sb, track, errMsg } from './supabase.js';
import { sendMessage, removeMedia, mediaHTML, hydrate, lightbox, isPlaceholder, ACCEPT } from './media.js';
import { shareInvite, inviteUrl } from './share.js';
import { $, esc, icon, verifiedBadge, listTime, fmtTime, fmtDay, copyText, validateImage, toast, setBusy, openModal, confirmDialog, debounce, badgeHtml } from './utils.js';

let me, host, mine = [], disc = [], loaded = false, last = 0, ready = false, err = '', q = '';
let touching = false, pending = false, cache = { m: '', d: '' };
const num = (n) => Number(n || 0).toLocaleString('id-ID');
const dateFmt = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
const hue = (s) => { let h = 0; for (const ch of String(s || '?')) h = (h * 31 + ch.codePointAt(0)) % 360; return h; };
const chAv = (t, s = 52, url = '') => `<span class="chav" style="--h:${hue(t)};--s:${s}px" aria-hidden="true"><b>${esc([...String(t || '?').trim()][0]?.toUpperCase() || '?')}</b>${url ? `<img src="${esc(url)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ''}</span>`;
const nm = (c) => `<span class="cn">${esc(c.title)}${c.is_official ? badgeHtml('official', 14, true) : ''}</span>`;
const isNew = (c) => c.created_at && Date.now() - new Date(c.created_at) < 86400000;

/* ---------------- daftar di tab Pembaruan ---------------- */
export function mountChannels(profile, el) {
  me = profile;
  if (host !== el) { host = el; cache = { m: '', d: '' }; bind(); }
  draw();
  if (!loaded) { loaded = true; fetchAll(); listen(); } else if (Date.now() - last > 15000) load();
}

async function fetchAll() {
  last = Date.now();
  const [a, b] = await Promise.all([sb.rpc('list_my_channels'), sb.rpc('discover_channels', { lim: 40 })]);
  ready = true;
  if (a.error || b.error) { err = errMsg(a.error || b.error); draw(); return; }
  err = ''; mine = a.data || []; disc = b.data || []; draw();
  const ch = new URLSearchParams(location.search).get('ch');
  if (ch) { history.replaceState(null, '', '/updates'); const c = mine.find((x) => x.conv_id === ch); if (c) openChannel(c); }
}
const load = debounce(fetchAll, 150);

function listen() {
  track(sb.channel('chan-' + me.id)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, ({ new: m }) => mine.some((c) => c.conv_id === m.conversation_id) && load())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'conversation_members', filter: `user_id=eq.${me.id}` }, () => load())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations', filter: 'type=eq.channel' }, () => load())
    .subscribe());
  setInterval(() => { if (!document.hidden && host?.isConnected) load(); }, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && host?.isConnected) load(); });
  document.addEventListener('pointerdown', (e) => { if (host?.contains(e.target)) touching = true; }, true);
  const release = () => { if (!touching) return; setTimeout(() => { touching = false; if (pending) { pending = false; draw(); } }, 300); };
  document.addEventListener('pointerup', release, true);
  document.addEventListener('pointercancel', release, true);
}

const SHELL = `<section class="chs" aria-label="Saluran">
  <div class="chs-head"><div><h2>Saluran</h2><p class="dim">Kiriman satu arah dari pembuatnya</p></div><button class="btn primary" id="chNew" type="button">${icon('plus', 18)} Buat</button></div>
  <div id="chMine"></div>
  <div class="chs-head sp"><div><h2>Jelajahi saluran</h2><p class="dim">Dibuat oleh pengguna ORVIX, urut pengikut terbanyak</p></div><span class="live on" aria-hidden="true"><i></i><b>Real-time</b></span></div>
  <label class="csearch">${icon('search', 18)}<input id="chQ" type="search" placeholder="Cari saluran" autocomplete="off" enterkeyhint="search" aria-label="Cari saluran"></label>
  <div id="chDisc"></div>
</section>`;

const skel = '<div class="skel-list" aria-hidden="true"><i></i><i></i></div>';
const empty = (ico, title, text, btn) => `<div class="cempty"><span class="ico">${icon(ico, 26)}</span><b>${title}</b><p>${text}</p>${btn || ''}</div>`;

function draw() {
  if (!host?.isConnected) return;
  if (touching) { pending = true; return; }
  if (!host.querySelector('#chMine')) { host.innerHTML = SHELL; cache = { m: '', d: '' }; const i = host.querySelector('#chQ'); if (i) i.value = q; }
  let m;
  if (err) m = empty('megaphone', 'Saluran belum aktif', `${esc(err)}. Jalankan file SQL saluran di Supabase.`);
  else if (!ready) m = skel;
  else if (mine.length) m = `<div class="clist">${mine.map((c) => `<div class="crow"><button type="button" class="cmain" data-open="${c.conv_id}">${chAv(c.title, 52, c.avatar_url)}<span class="cbody"><span class="ctop">${nm(c)}<time>${listTime(c.last_at)}</time></span><span class="cbot"><span class="csub ell">${esc(c.last_content || 'Belum ada kiriman')}</span>${c.unread > 0 ? `<span class="unread">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}</span></span></button></div>`).join('')}</div>`;
  else m = empty('megaphone', 'Belum mengikuti saluran', 'Ikuti saluran di bawah, atau buat saluranmu sendiri.');
  const ql = q.trim().toLowerCase();
  const top = disc.filter((c) => !c.following && (!ql || (c.title + ' ' + (c.description || '')).toLowerCase().includes(ql)));
  let d;
  if (!ready) d = skel;
  else if (top.length) d = `<div class="clist">${top.map((c) => `<article class="ccard"><button type="button" class="cmain" data-prof="${c.conv_id}" aria-label="Lihat profil ${esc(c.title)}">${chAv(c.title, 52, c.avatar_url)}<span class="cbody"><span class="ctop">${nm(c)}${isNew(c) ? '<span class="pill-new">Baru</span>' : ''}</span><span class="csub clamp2">${esc(c.description || 'Tanpa deskripsi')}</span><span class="cmeta">${icon('users', 14)} ${num(c.followers)} pengikut</span></span></button><button type="button" class="btn sm primary cfol" data-follow="${c.conv_id}">Ikuti</button></article>`).join('')}</div>`;
  else if (ql) d = empty('search', 'Tidak ditemukan', `Tidak ada saluran yang cocok dengan "${esc(q.trim())}".`);
  else d = empty('megaphone', disc.length ? 'Semua saluran sudah kamu ikuti' : 'Belum ada saluran dari pengguna', disc.length ? 'Saluran baru dari pengguna lain akan muncul di sini secara langsung.' : 'Jadilah yang pertama membuat saluran.', '<button type="button" class="btn primary" data-newch>' + icon('plus', 18) + ' Buat saluran</button>');
  const put = (sel, k, v) => { if (cache[k] !== v) { cache[k] = v; host.querySelector(sel).innerHTML = v; } };
  put('#chMine', 'm', m); put('#chDisc', 'd', d);
}

function bind() {
  host.onclick = async (e) => {
    const o = e.target.closest('[data-open]'); if (o) return openChannel(mine.find((c) => c.conv_id === o.dataset.open));
    const f = e.target.closest('[data-follow]');
    if (f) { if (await follow(f.dataset.follow, f)) { const x = mine.find((y) => y.conv_id === f.dataset.follow); if (x) openChannel(x); } return; }
    const p = e.target.closest('[data-prof]'); if (p) return openProfile(p.dataset.prof);
    if (e.target.closest('#chNew') || e.target.closest('[data-newch]')) return newChannel();
  };
  host.oninput = (e) => { if (e.target.id === 'chQ') { q = e.target.value; draw(); } };
}

async function follow(id, btn) {
  if (btn) setBusy(btn, true);
  const { error } = await sb.rpc('follow_channel', { conv: id });
  if (error) { if (btn) setBusy(btn, false); toast(errMsg(error), 'error'); return false; }
  toast('Kamu mengikuti saluran ini', 'success'); await fetchAll(); return true;
}

/* ---------------- foto saluran ---------------- */
function pickImage(cb) {
  const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/jpeg,image/png,image/webp';
  i.onchange = () => { const f = i.files[0]; if (!f) return; const bad = validateImage(f, 15); if (bad) return toast(bad, 'error'); cb(f); };
  i.click();
}
async function squareBlob(file, size = 512) {
  const bmp = await createImageBitmap(file).catch(() => null); if (!bmp) throw new Error('Foto tidak bisa dibaca');
  const s = Math.min(bmp.width, bmp.height), c = document.createElement('canvas'); c.width = c.height = size;
  c.getContext('2d').drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, size, size); bmp.close?.();
  for (const [t, q] of [['image/webp', 0.85], ['image/jpeg', 0.85]]) { const b = await new Promise((r) => c.toBlob(r, t, q)); if (b && b.type === t) return b; }
  throw new Error('Foto tidak bisa diproses');
}
function dropOld(url) {
  const i = url ? url.indexOf('/avatars/') : -1; if (i < 0) return;
  const path = decodeURIComponent(url.slice(i + 9).split('?')[0]);
  if (path.startsWith(me.id + '/ch/')) sb.storage.from('avatars').remove([path]).catch(() => {});
}
async function setAvatar(conv, file, oldUrl) {
  const blob = await squareBlob(file), path = `${me.id}/ch/${conv}-${Date.now()}.${blob.type === 'image/webp' ? 'webp' : 'jpg'}`;
  const up = await sb.storage.from('avatars').upload(path, blob, { contentType: blob.type, cacheControl: '31536000' }); if (up.error) throw up.error;
  const url = sb.storage.from('avatars').getPublicUrl(path).data.publicUrl;
  const { error } = await sb.rpc('orvix_set_channel_avatar', { p_conv: conv, p_url: url });
  if (error) { sb.storage.from('avatars').remove([path]).catch(() => {}); throw error; }
  dropOld(oldUrl); return url;
}

/* ---------------- buat & ubah saluran ---------------- */
const form = (p = {}) => `<div class="field"><label for="cn">Nama saluran</label><input class="inp" id="cn" maxlength="60" value="${esc(p.title || '')}"></div><div class="field"><label for="cd">Deskripsi (opsional)</label><textarea class="inp" id="cd" maxlength="300" rows="3">${esc(p.description || '')}</textarea></div><div class="field"><label for="cp">Visibilitas</label><select class="inp" id="cp"><option value="1"${p.is_public === false ? '' : ' selected'}>Publik: muncul di rekomendasi</option><option value="0"${p.is_public === false ? ' selected' : ''}>Privat: hanya lewat link</option></select></div><p class="err" id="ce"></p>`;
function newChannel() {
  let pf = null;
  const m = openModal({ title: 'Buat saluran', html: `<div class="avpick"><button type="button" class="avbtn" id="cph" aria-label="Pilih foto saluran"><span id="cpv">${icon('camera', 28)}</span></button><span class="dim">Foto saluran (opsional)</span></div>${form()}<p class="dim" style="margin-bottom:12px">Hanya kamu yang bisa mengirim di saluran. Pengikut hanya membaca.</p><button type="button" class="btn primary block lg" id="cg">Buat saluran</button>` });
  $('#cph', m.el).onclick = () => pickImage((f) => { pf = f; $('#cpv', m.el).innerHTML = `<img src="${URL.createObjectURL(f)}" alt="">`; });
  $('#cg', m.el).onclick = async (e) => {
    const name = $('#cn', m.el).value.trim(); if (!name) return ($('#ce', m.el).textContent = 'Isi nama saluran.');
    setBusy(e.currentTarget, true, 'Membuat…');
    const { data, error } = await sb.rpc('create_channel', { p_name: name, p_desc: $('#cd', m.el).value, p_public: $('#cp', m.el).value === '1' });
    if (error) { setBusy(e.currentTarget, false); return ($('#ce', m.el).textContent = errMsg(error)); }
    if (pf) { try { await setAvatar(data, pf, null); } catch (x) { toast('Saluran dibuat, tetapi foto gagal diunggah: ' + errMsg(x), 'error'); } }
    m.close(); await fetchAll(); const c = mine.find((x) => x.conv_id === data); if (c) openChannel(c);
  };
}
function editChannel(p, done) {
  const m = openModal({ title: 'Ubah saluran', html: `${form(p)}<button type="button" class="btn primary block lg" id="cg">Simpan</button>` });
  $('#cg', m.el).onclick = async (e) => {
    const name = $('#cn', m.el).value.trim(); if (!name) return ($('#ce', m.el).textContent = 'Isi nama saluran.');
    setBusy(e.currentTarget, true, 'Menyimpan…');
    const { error } = await sb.rpc('orvix_update_channel', { p_conv: p.conv_id, p_name: name, p_desc: $('#cd', m.el).value, p_public: $('#cp', m.el).value === '1' });
    if (error) { setBusy(e.currentTarget, false); return ($('#ce', m.el).textContent = errMsg(error)); }
    m.close(); toast('Saluran diperbarui', 'success'); done?.();
  };
}

/* ---------------- profil saluran (ala WhatsApp) ---------------- */
const stat = (n) => (n == null ? '–' : num(n));
async function openProfile(id, ctx = {}) {
  const v = document.createElement('div'); v.className = 'chp'; v.setAttribute('role', 'dialog'); v.setAttribute('aria-modal', 'true'); v.setAttribute('aria-label', 'Profil saluran');
  const seed = mine.find((x) => x.conv_id === id) || disc.find((x) => x.conv_id === id);
  v.innerHTML = `<div class="chp-card"><div class="chp-cover" style="--h:${hue(seed?.title)}"><button type="button" class="ibtn glass" data-x aria-label="Tutup">${icon('back')}</button></div><div class="chp-main"><div class="chp-id"><div class="chp-av"><span class="avw">${chAv(seed?.title, 96, seed?.avatar_url)}</span></div><h2 class="chp-name">${esc(seed?.title || 'Memuat…')}</h2></div><div class="chp-det"><div class="skel-list"><i></i><i></i><i></i></div></div></div></div>`;
  document.body.append(v); document.body.classList.add('noscroll');
  let p = null, code = null, gal = [];
  const key = (e) => { if (e.key === 'Escape' && !document.querySelector('.modal-back, .lbx')) close(); };
  const close = () => { document.removeEventListener('keydown', key); v.remove(); if (!document.querySelector('.chv, .modal-back')) document.body.classList.remove('noscroll'); };
  document.addEventListener('keydown', key);
  const row = (ic, label, val) => `<div class="irow">${icon(ic, 20)}<span><small>${label}</small>${val}</span></div>`;
  const pill = (t, cls = '') => `<span class="pl ${cls}">${t}</span>`;
  const paint = () => {
    const own = p.is_owner, fol = p.following, rows = [];
    const act = (a, ic, t, cls = '') => `<button type="button" class="act ${cls}" data-a="${a}">${icon(ic, 22)}<span>${t}</span></button>`;
    rows.push(row('users', 'Pengikut', num(p.followers)));
    if (p.created_at) rows.push(row('clock', 'Dibuat pada', dateFmt.format(new Date(p.created_at))));
    if (p.posts != null) rows.push(row('image', 'Kiriman', `${num(p.posts)} kiriman, ${num(p.media)} media`));
    rows.push(row('megaphone', 'Kiriman terakhir', p.last_post_at ? `${fmtDay(p.last_post_at)}, ${fmtTime(p.last_post_at)}` : 'Belum ada kiriman'));
    if (p.is_public != null) rows.push(row(p.is_public ? 'globe' : 'lock', 'Visibilitas', p.is_public ? 'Publik, muncul di rekomendasi' : 'Privat, hanya lewat link'));
    const long = (p.description || '').length > 170;
    v.innerHTML = `<div class="chp-card"><div class="chp-cover" style="--h:${hue(p.title)}"><button type="button" class="ibtn glass" data-x aria-label="Tutup">${icon('back')}</button>${fol ? `<button type="button" class="ibtn glass" data-a="share" aria-label="Bagikan">${icon('share')}</button>` : ''}</div>
    <div class="chp-main">
      <div class="chp-id"><div class="chp-av"><span class="avw">${chAv(p.title, 96, p.avatar_url)}${own ? `<button type="button" class="avcam" data-a="photo" aria-label="Ubah foto saluran">${icon('camera', 18)}</button>` : ''}</span></div>
        <h2 class="chp-name">${esc(p.title)}${p.is_official ? badgeHtml('official', 20, true) : ''}</h2>
        <p class="chp-sub">Saluran · ${num(p.followers)} pengikut</p>
        <div class="chp-pills">${p.is_public == null ? '' : p.is_public ? pill(icon('globe', 14) + ' Publik') : pill(icon('lock', 14) + ' Privat')}${p.is_official ? pill('Resmi', 'ok') : ''}${own ? pill('Kamu pemilik', 'pri') : fol ? pill(icon('check', 14) + ' Mengikuti', 'pri') : ''}</div>
        ${fol ? `<div class="chp-actions">${act('open', 'megaphone', 'Buka', 'pri')}${act('share', 'share', 'Bagikan')}${own ? act('edit', 'edit', 'Ubah') : ''}</div>` : ''}
      </div>
      <div class="chp-det">
        <div class="chp-stats"><div><b>${num(p.followers)}</b><span>Pengikut</span></div><div><b>${stat(p.posts)}</b><span>Kiriman</span></div><div><b>${stat(p.media)}</b><span>Media</span></div></div>
        <div class="chp-box"><h3>Deskripsi</h3>${p.description ? `<p class="pdesc${long ? ' clamp' : ''}">${esc(p.description)}</p>${long ? '<button type="button" class="more" data-a="more">Selengkapnya</button>' : ''}` : '<p class="dim">Belum ada deskripsi.</p>'}</div>
        <div id="pxg"></div><div id="pxl"></div>
        <div class="chp-box"><h3>Info saluran</h3>${rows.join('')}</div>
        ${p.owner_name ? `<div class="chp-box"><h3>Pemilik</h3><div class="orow">${chAv(p.owner_name, 44)}<span class="grow"><b class="ell" style="display:block">${esc(p.owner_name)}${p.owner_verified ? verifiedBadge(15) : ''}</b><small class="dim">${p.owner_username ? '@' + esc(p.owner_username) : 'Pemilik saluran'}</small></span></div></div>` : ''}
        ${fol && !own ? `<button type="button" class="btn danger chp-danger" data-a="unf">${icon('logout', 20)} Berhenti mengikuti</button>` : ''}
        ${own ? `<button type="button" class="btn danger chp-danger" data-a="del">${icon('trash', 20)} Hapus saluran</button>` : ''}
      </div>
    </div>
    ${!fol ? `<div class="chp-cta"><button type="button" class="btn primary block lg" data-a="follow">Ikuti saluran</button></div>` : ''}</div>`;
    paintExtra(); v.querySelector('[data-x]')?.focus({ preventScroll: true });
  };
  const paintExtra = () => {
    const g = v.querySelector('#pxg'), l = v.querySelector('#pxl'); if (!g || !l) return;
    g.innerHTML = gal.length ? `<div class="chp-box"><h3>Media terbaru</h3><div class="pgal">${gal.map((m) => mediaHTML(m)).join('')}</div></div>` : '';
    l.innerHTML = code ? `<div class="chp-box"><h3>Link saluran</h3><div class="lnk"><input class="inp" readonly value="${esc(inviteUrl(code))}" aria-label="Link saluran"><button type="button" class="btn primary" data-a="copy">${icon('copy', 18)} Salin</button></div></div>` : '';
    hydrate(v);
  };
  const fallback = () => {
    const m = mine.find((x) => x.conv_id === id), d = disc.find((x) => x.conv_id === id), s = m || d; if (!s) return [];
    return [{ conv_id: id, title: s.title, description: s.description, is_official: s.is_official, is_public: null, followers: s.followers, following: !!m || !!s.following, is_owner: !!m?.is_owner, created_at: s.created_at || null, owner_name: null, owner_username: null, owner_verified: false, avatar_url: s.avatar_url || null, posts: null, media: null, last_post_at: m?.last_content ? m.last_at : null }];
  };
  const reload = async () => {
    let { data, error } = await sb.rpc('orvix_channel_profile', { conv: id });
    if (error && /schema cache|could not find|does not exist/i.test(error.message || '')) { data = fallback(); error = null; }
    if (error || !data?.[0]) { toast(error ? errMsg(error) : 'Saluran tidak ditemukan', 'error'); close(); return false; }
    p = data[0]; code = null; gal = []; paint();
    if (p.following) {
      const [g, c] = await Promise.all([
        sb.from('messages').select('id,media_path,media_type,created_at').eq('conversation_id', id).not('media_path', 'is', null).is('deleted_at', null).order('created_at', { ascending: false }).limit(9),
        sb.rpc('get_invite_code', { conv: id })]);
      gal = g.data || []; code = c.data || null; if (v.isConnected) paintExtra();
    }
    return true;
  };
  v.onclick = async (e) => {
    if (e.target === v || e.target.closest('[data-x]')) return close();
    const im = e.target.closest('.pgal img'); if (im) return lightbox(im.src);
    const b = e.target.closest('[data-a]'); if (!b || !p) return; const a = b.dataset.a;
    if (a === 'more') { const d = v.querySelector('.pdesc'); const open = d.classList.toggle('clamp'); b.textContent = open ? 'Selengkapnya' : 'Tampilkan lebih sedikit'; return; }
    if (a === 'open') { close(); if (!ctx.inView) { const c = mine.find((x) => x.conv_id === id); if (c) openChannel(c); } return; }
    if (a === 'share') return shareInvite(id, p.title, 'saluran');
    if (a === 'copy') return copyText(inviteUrl(code));
    if (a === 'photo') {
      const m = openModal({ title: 'Foto saluran', sheet: true, html: `<div class="col"><button type="button" class="btn primary lg" data-s="pick">${icon('camera', 20)} Pilih foto baru</button>${p.avatar_url ? `<button type="button" class="btn danger lg" data-s="del">${icon('trash', 20)} Hapus foto</button>` : ''}</div>` });
      m.el.onclick = (e2) => {
        const k = e2.target.closest('[data-s]')?.dataset.s; if (!k) return; m.close();
        const done = async () => { await fetchAll(); await reload(); ctx.onChange?.(); };
        if (k === 'pick') pickImage(async (f) => { toast('Mengunggah foto…'); try { await setAvatar(id, f, p.avatar_url); toast('Foto saluran diperbarui', 'success'); await done(); } catch (x) { toast(errMsg(x), 'error'); } });
        else (async () => { const { error } = await sb.rpc('orvix_set_channel_avatar', { p_conv: id, p_url: null }); if (error) return toast(errMsg(error), 'error'); dropOld(p.avatar_url); toast('Foto dihapus', 'success'); await done(); })();
      };
      return;
    }
    if (a === 'edit') return editChannel(p, async () => { await fetchAll(); await reload(); ctx.onChange?.(); });
    if (a === 'follow') { if (await follow(id, b)) await reload(); return; }
    if (a === 'unf') {
      if (!(await confirmDialog({ title: 'Berhenti mengikuti?', message: `Kamu tidak akan menerima kiriman dari ${esc(p.title)} lagi.`, confirmText: 'Berhenti', danger: true }))) return;
      const { error } = await sb.rpc('unfollow_channel', { conv: id }); if (error) return toast(errMsg(error), 'error');
      await fetchAll(); close(); ctx.onLeave?.(); return;
    }
    if (a === 'del') {
      if (!(await confirmDialog({ title: 'Hapus saluran?', message: `Saluran ${esc(p.title)} beserta semua kirimannya akan dihapus permanen untuk ${num(p.followers)} pengikut.`, confirmText: 'Hapus', danger: true }))) return;
      setBusy(b, true);
      const { data: ms } = await sb.from('messages').select('media_path').eq('conversation_id', id).not('media_path', 'is', null);
      const paths = (ms || []).map((x) => x.media_path).filter(Boolean); if (paths.length) await sb.storage.from('chat-media').remove(paths).catch(() => {});
      const { error } = await sb.rpc('orvix_delete_channel', { p_conv: id }); if (error) { setBusy(b, false); return toast(errMsg(error), 'error'); }
      toast('Saluran dihapus', 'success'); await fetchAll(); close(); ctx.onLeave?.();
    }
  };
  await reload();
}

/* ---------------- tampilan saluran (kiriman) ---------------- */
async function openChannel(c) {
  if (!c) return;
  const v = document.createElement('div'); v.className = 'chv'; v.setAttribute('role', 'dialog'); v.setAttribute('aria-modal', 'true'); v.setAttribute('aria-label', c.title);
  v.innerHTML = `<header class="thead chh"><button type="button" class="ibtn" data-back aria-label="Kembali">${icon('back')}</button><button type="button" class="chh-id" data-prof aria-label="Lihat profil saluran">${chAv(c.title, 42, c.avatar_url)}<span class="grow"><span class="t1 ell">${nm(c)}</span><span class="sub" id="cf">${num(c.followers)} pengikut · ketuk untuk info</span></span></button><button type="button" class="ibtn" data-share aria-label="Bagikan link">${icon('share')}</button></header>
  <div class="msgs" id="cm" role="log" aria-live="polite"><div class="empty">Memuat…</div></div>
  ${c.is_owner ? `<form class="composer" id="cc"><button type="button" class="ibtn" id="ca" aria-label="Kirim foto atau video">${icon('clip')}</button><input type="file" id="cfile" accept="${ACCEPT}" hidden><textarea class="inp" id="ct" rows="1" maxlength="4000" placeholder="Tulis kiriman untuk pengikut" aria-label="Tulis kiriman"></textarea><button type="submit" class="send" id="cs" aria-label="Kirim" disabled>${icon('send')}</button></form>` : `<div class="ro">${icon('lock', 16)} Hanya pemilik saluran yang dapat mengirim</div>`}`;
  document.body.append(v); document.body.classList.add('noscroll');
  let rows = [], closed = false;
  const list = $('#cm', v);
  const draw2 = (stick = true) => {
    let lastDay = '', h = ''; const side = c.is_owner ? 'out' : 'in';
    rows.forEach((m) => {
      const d = new Date(m.created_at).toDateString(); if (d !== lastDay) { h += `<div class="day">${fmtDay(m.created_at)}</div>`; lastDay = d; }
      h += m.deleted_at ? `<div class="post gone ${side}">Kiriman dihapus</div>` : `<article class="post ${side}" data-m="${m.id}">${mediaHTML(m)}${isPlaceholder(m) ? '' : `<p class="ptext">${esc(m.content)}</p>`}<footer><time>${fmtTime(m.created_at)}</time>${c.is_owner ? `<button type="button" class="pm" data-del="${m.id}" aria-label="Hapus kiriman">${icon('trash', 18)}</button>` : ''}</footer></article>`;
    });
    list.innerHTML = h || `<div class="empty">${icon('megaphone', 36)}<p>${c.is_owner ? 'Kirim kiriman pertamamu untuk pengikut.' : 'Belum ada kiriman.'}</p></div>`;
    hydrate(list).then(() => stick && (list.scrollTop = list.scrollHeight)); if (stick) list.scrollTop = list.scrollHeight;
  };
  const read = () => sb.rpc('mark_read', { conv: c.conv_id }).then(() => load(), () => {});
  const close = () => { closed = true; sb.removeChannel(live); document.body.classList.remove('noscroll'); v.remove(); load(); };
  const { data } = await sb.from('messages').select('*').eq('conversation_id', c.conv_id).order('created_at', { ascending: false }).limit(80);
  rows = (data || []).reverse(); draw2(); read();
  const live = sb.channel('chv-' + c.conv_id)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${c.conv_id}` }, ({ new: m }) => { if (!rows.some((x) => x.id === m.id)) { rows.push(m); draw2(); read(); } })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `conversation_id=eq.${c.conv_id}` }, ({ new: m }) => { const i = rows.findIndex((x) => x.id === m.id); if (i >= 0) { rows[i] = m; draw2(false); } })
    .subscribe();
  $('[data-back]', v).onclick = close;
  $('[data-share]', v).onclick = () => shareInvite(c.conv_id, c.title, 'saluran');
  $('[data-prof]', v).onclick = () => openProfile(c.conv_id, { inView: true, onLeave: close, onChange: () => { const x = mine.find((y) => y.conv_id === c.conv_id); if (x) { Object.assign(c, x); } } });
  list.onclick = async (e) => {
    const im = e.target.closest('.mm img'); if (im) return lightbox(im.src);
    const d = e.target.closest('[data-del]'); if (!d) return;
    const m = rows.find((x) => x.id === d.dataset.del); if (!m) return;
    if (!(await confirmDialog({ title: 'Hapus kiriman?', message: 'Kiriman akan dihapus untuk semua pengikut.', confirmText: 'Hapus', danger: true }))) return;
    await removeMedia(m); const { error } = await sb.from('messages').update({ deleted_at: new Date().toISOString() }).eq('id', m.id); if (error) toast(errMsg(error), 'error');
  };
  if (c.is_owner) {
    const t = $('#ct', v), s = $('#cs', v);
    t.oninput = () => { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 140) + 'px'; s.disabled = !t.value.trim(); };
    $('#ca', v).onclick = () => $('#cfile', v).click();
    const send = async (file) => { s.disabled = true; try { const row = await sendMessage({ conv: c.conv_id, me: me.id, text: t.value, file }); t.value = ''; t.style.height = 'auto'; if (!rows.some((x) => x.id === row.id)) { rows.push(row); draw2(); } } catch (x) { toast(errMsg(x), 'error'); } t.oninput(); };
    $('#cfile', v).onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) { toast('Mengunggah…'); send(f); } };
    $('#cc', v).onsubmit = (e) => { e.preventDefault(); if (t.value.trim()) send(null); };
    t.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer:fine)').matches) { e.preventDefault(); $('#cc', v).requestSubmit(); } };
  }
  document.addEventListener('keydown', function k(e) { if (closed) return document.removeEventListener('keydown', k); if (e.key === 'Escape' && !document.querySelector('.modal-back, .chp')) close(); });
}
