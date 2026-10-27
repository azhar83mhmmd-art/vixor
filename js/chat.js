// Dashboard chat: daftar percakapan, chat pribadi/grup, teman, Realtime.
import { sb, requireAuth, track, fetchProfiles, fetchFriendships, errMsg, cacheMe } from './supabase.js';
import { openPremiumHub } from './premium.js';
import { sendMessage, removeMedia, mediaHTML, hydrate, lightbox, isPlaceholder, ACCEPT } from './media.js';
import { shareInvite } from './share.js';
import { pushActiveLocal } from './push.js';
import { draftBind, draftClear, openScheduleModal, openScheduledList, openSearch, premiumInfo } from './advmsg.js';
import { startCall, joinCall, activeSession, openCalls, bus as callBus } from './calls-core.js';
import { $, $$, esc, icon, avatar, nameWithBadge, verifiedBadge, fmtTime, fmtDay, listTime, relTime, toast, setBusy, openModal, confirmDialog, copyText, debounce, mountShell, profileScreen, isPremium } from './utils.js';

const { profile: me } = await requireAuth({ shell: '/chat' });
mountShell('/chat', me.role === 'admin');
const CK = 'orvix:convs:' + me.id;
const saveConvs = (d) => { try { sessionStorage.setItem(CK, JSON.stringify(d)); } catch { /* abaikan */ } };

const PAGE = 40, DEL_MS = 60 * 60 * 1000;
const editMs = () => (isPremium(me) ? 60 : 15) * 60 * 1000;   // Premium: edit pesan hingga 1 jam
let sel = new Set(), selMode = false, blocked = new Set(), lpFired = false;
let msel = new Set(), mlpT, mlpFired = false, selPushed = false, skipPop = false;   // pilihan pesan (tekan lama) di dalam percakapan
let convs = [], tab = 'all', q = '', activeId = null, msgs = [], hasMore = false, seq = 0;
let reads = new Map(), members = [], disSecs = null, stInfo = new Map(), sUrls = new Map();   // status pesan, anggota, pesan sementara, referensi story
const prof = new Map();            // cache profil
const layout = $('#layout'), thread = $('#thread'), listEl = $('#convList');

$('#btnReq').innerHTML = icon('bell') + '<span class="badge-n hide" id="reqN"></span>';
$('#btnPrem').innerHTML = icon('crown'); $('#btnFriends').innerHTML = icon('users'); $('#btnAdd').innerHTML = icon('userplus'); $('#fab').innerHTML = icon('plus', 24);
$('.searchbar').innerHTML = `${icon('search')}<input class="inp" id="q" type="search" placeholder="Cari chat atau ID ORVIX" aria-label="Cari chat atau ID ORVIX" autocomplete="off">`;
$('.pane-head').insertAdjacentHTML('afterend', `<header class="pane-head sel-head hide" id="selHead"><button class="ibtn" id="selX" aria-label="Batal memilih">${icon('x')}</button><h1 id="selN">0</h1><button class="ibtn" id="selAll" aria-label="Pilih semua">${icon('selall')}</button><button class="ibtn" id="selPin" aria-label="Sematkan chat">${icon('pin')}</button><button class="ibtn" id="selDel" aria-label="Hapus chat">${icon('trash')}</button></header>`);
listEl.insertAdjacentHTML('beforebegin', '<div id="conn" class="alert warn hide" style="margin:0 14px 8px">Menghubungkan ulang…</div>');

let lastSeenTxt = '';
const lastSeenText = (t) => (Date.now() - new Date(t) < 120000 ? 'Online' : 'Terakhir aktif ' + relTime(t));
const paintSub = () => { const el = $('#hSub'); if (!el) return; const c = curConv() || {}; el.textContent = [c.conv_type === 'group' ? 'Grup' : lastSeenTxt, disSecs ? 'Pesan sementara ' + DIS[disSecs] : ''].filter(Boolean).join(' · '); };
const DIS = { 0: 'Nonaktif', 86400: '24 jam', 604800: '7 hari', 7776000: '90 hari' };
const convName = (c) => (c.conv_type === 'group' ? c.title || 'Grup' : c.other_name || 'Pengguna');
const previewOf = (c) => (c.last_at ? (c.last_deleted ? (c.last_sender === me.id ? 'Kamu menghapus pesan ini' : 'Pesan ini telah dihapus') : (c.last_sender === me.id ? 'Kamu: ' : '') + c.last_content) : 'Belum ada pesan');

/* ---------- daftar percakapan ---------- */
async function loadConvs() {
  if (!convs.length) { try { const c = JSON.parse(sessionStorage.getItem(CK) || 'null'); if (c?.length) { convs = c.filter((x) => x.conv_type !== 'channel'); renderList(); } } catch { /* abaikan */ } }
  const { data, error } = await sb.rpc('list_my_conversations');
  if (error) { listEl.innerHTML = `<div class="empty"><h3>Gagal memuat chat</h3><p>${esc(errMsg(error))}</p><button class="btn" id="rt" style="margin-top:12px">Coba lagi</button></div>`; $('#rt').onclick = loadConvs; return; }
  convs = data.filter((x) => x.conv_type !== 'channel'); saveConvs(convs); renderList();
  convs.filter((c) => c.unread > 0).slice(0, 20).forEach((c) => markDelivered(c.conv_id));
}
const refreshList = debounce(async () => { const { data } = await sb.rpc('list_my_conversations'); if (data) { convs = data.filter((x) => x.conv_type !== 'channel'); saveConvs(convs); renderList(); } }, 400);

function renderList() {
  const s = q.trim().toLowerCase();
  let rows = convs.filter((c) => (tab === 'all' || c.conv_type === tab) && (!s || convName(c).toLowerCase().includes(s) || (c.other_username || '').includes(s) || (c.last_content || '').toLowerCase().includes(s)));
  let html = /^\d{8}$/.test(s) ? `<button class="item" data-id-search="${esc(s)}"><span class="av" style="width:46px;height:46px">${icon('search')}</span><span class="grow"><span class="t">Cari ID ORVIX ${esc(s)}</span><span class="p">Ketuk untuk mencari teman</span></span></button>` : '';
  if (!rows.length && !html) {
    html = convs.length ? `<div class="empty"><h3>Tidak ada hasil</h3><p>Coba kata kunci lain.</p></div>` : `<div class="empty">${icon('chat', 40)}<h3>Belum ada percakapan</h3><p>Tambahkan teman dengan ID ORVIX-nya, lalu mulai chat.</p><button class="btn primary" id="emptyAdd" style="margin-top:14px">Tambah teman</button></div>`;
  }
  html += rows.map((c) => {
    const nm = convName(c), av = c.conv_type === 'group' ? `<span class="av" style="width:48px;height:48px">${icon('users')}</span>` : avatar(nm, c.other_avatar, 48);
    return `<button class="item ${c.conv_id === activeId ? 'on' : ''}${sel.has(c.conv_id) ? ' sel' : ''}" data-c="${c.conv_id}" aria-pressed="${sel.has(c.conv_id)}">${av}<span class="grow"><span class="t"><span class="ell">${nameWithBadge(nm, c.other_verified, 15, false, c.conv_type === 'group' ? null : c.other_id)}</span><span class="when">${listTime(c.last_at || c.created_at)}</span></span><span class="row between gap"><span class="p ell ${c.last_deleted ? 'gone-p' : ''}">${c.last_deleted ? icon('ban', 13) + ' ' : ''}${esc(previewOf(c))}</span>${c.pinned ? `<span class="pinned" aria-label="Disematkan">${icon('pin', 15)}</span>` : ''}${c.unread > 0 ? `<span class="unread" aria-label="${c.unread} belum dibaca">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}</span></span></button>`;
  }).join('');
  listEl.innerHTML = html;
  $('#emptyAdd') && ($('#emptyAdd').onclick = addFriendModal);
}
listEl.onclick = (e) => {
  if (lpFired) { lpFired = false; return; }
  const it = e.target.closest('[data-c]'); if (it && selMode) return toggleSel(it.dataset.c);
  const s = e.target.closest('[data-id-search]'); if (s) return addFriendModal(s.dataset.idSearch);
  const c = e.target.closest('[data-c]'); if (c) openConv(c.dataset.c);
};
$('#q').oninput = (e) => { q = e.target.value; renderList(); };
/* ---------- pilih beberapa chat (tekan lama), seperti di WhatsApp ---------- */
let lpT, lpX = 0, lpY = 0;
const selectOn = (id) => { if (!sel.has(id)) { sel.add(id); navigator.vibrate?.(12); } paintSel(); };
function toggleSel(id) { sel.has(id) ? sel.delete(id) : sel.add(id); paintSel(); }
function exitSel() { sel.clear(); paintSel(); }
function paintSel() {
  selMode = sel.size > 0; layout.classList.toggle('selecting', selMode);
  $('#selHead').classList.toggle('hide', !selMode); $('.pane-head:not(.sel-head)').classList.toggle('hide', selMode);
  $('#selN').textContent = sel.size; const rows = convs.filter((c) => sel.has(c.conv_id));
  $('#selPin').setAttribute('aria-label', rows.length && rows.every((c) => c.pinned) ? 'Lepas sematan' : 'Sematkan chat');
  $('#selPin').classList.toggle('on', rows.length > 0 && rows.every((c) => c.pinned)); renderList();
}
listEl.addEventListener('pointerdown', (e) => { const it = e.target.closest('[data-c]'); if (!it || e.button > 0) return; lpX = e.clientX; lpY = e.clientY; clearTimeout(lpT); lpT = setTimeout(() => { lpFired = true; selectOn(it.dataset.c); }, 450); });
listEl.addEventListener('pointermove', (e) => { if (Math.abs(e.clientX - lpX) > 8 || Math.abs(e.clientY - lpY) > 8) clearTimeout(lpT); });
['pointerup', 'pointercancel', 'pointerleave', 'scroll'].forEach((ev) => listEl.addEventListener(ev, () => clearTimeout(lpT), true));
listEl.addEventListener('contextmenu', (e) => { const it = e.target.closest('[data-c]'); if (it) { e.preventDefault(); lpFired = true; selectOn(it.dataset.c); } });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || document.querySelector('.modal-back')) return;
  if (msel.size) exitMsel(); else if (selMode) exitSel();
});
$('#selX').onclick = exitSel;
$('#selAll').onclick = () => { const vis = [...listEl.querySelectorAll('[data-c]')].map((x) => x.dataset.c); vis.every((i) => sel.has(i)) ? vis.forEach((i) => sel.delete(i)) : vis.forEach((i) => sel.add(i)); paintSel(); };
$('#selPin').onclick = async () => {
  const rows = convs.filter((c) => sel.has(c.conv_id)), unpin = rows.length && rows.every((c) => c.pinned);
  const { error } = await sb.rpc('orvix_pin_conversations', { convs: [...sel], pin: !unpin });
  if (error) return toast(dbErr(error, '13b-hapus-pesan-chat.sql'), 'error'); toast(unpin ? 'Sematan dilepas' : 'Chat disematkan', 'success'); exitSel(); await loadConvs();
};
$('#selDel').onclick = async () => {
  const n = sel.size; if (!n) return;
  if (!(await confirmDialog({ title: n > 1 ? `Hapus ${n} chat?` : 'Hapus chat ini?', message: 'Riwayat chat dikosongkan dari daftarmu saja. Lawan chat tidak terpengaruh, dan chat muncul lagi jika ada pesan baru.', confirmText: 'Hapus', danger: true }))) return;
  const ids = [...sel], { error } = await sb.rpc('orvix_clear_conversations', { convs: ids });
  if (error) return toast(dbErr(error, '13b-hapus-pesan-chat.sql'), 'error');
  if (ids.includes(activeId)) { if (history.state?.c) history.back(); else closeConv(); }
  toast(n > 1 ? `${n} chat dihapus` : 'Chat dihapus', 'success'); exitSel(); await loadConvs();
};
const dbErr = (e, file) => (/could not find the function|does not exist|permission denied|schema cache|42883|42501|42P01/i.test(errMsg(e)) ? `Fitur belum aktif di database. Jalankan sql-parts/${file} di SQL Editor Supabase, lalu muat ulang halaman.` : errMsg(e));
$('#btnPrem').onclick = () => openPremiumHub(me, () => { cacheMe(me); render('auto'); });
$$('.tab').forEach((b) => b.onclick = () => { tab = b.dataset.t; $$('.tab').forEach((x) => x.setAttribute('aria-selected', x === b)); renderList(); });

/* ---------- thread ---------- */
async function ensureProfiles(ids) { const miss = ids.filter((i) => !prof.has(i)); if (miss.length) (await fetchProfiles(miss)).forEach((v, k) => prof.set(k, v)); }
const curConv = () => convs.find((c) => c.conv_id === activeId);
let unbindDraft = () => {};
const titleOf = (id) => { const c = convs.find((x) => x.conv_id === id); return c ? convName(c) : 'Percakapan'; };
function scheduleHere(text) {
  const c = curConv(); if (!c) return;
  openScheduleModal({ me, convId: c.conv_id, convTitle: convName(c), text, onDone: () => { const ci = $('#ci'); if (ci && text && ci.value.trim() === text) { ci.value = ''; ci.style.height = 'auto'; $('#sendBtn').disabled = true; draftClear(me, c.conv_id); } } });
}
function searchHere(all) {
  const c = all ? null : curConv(), senders = c && c.conv_type === 'group' ? members.filter((u) => u !== me.id).map((u) => ({ id: u, name: prof.get(u)?.display_name || 'Anggota' })) : c && c.other_id ? [{ id: c.other_id, name: c.other_name || 'Lawan chat' }] : [];
  openSearch({ me, convId: c ? c.conv_id : null, convTitle: c ? convName(c) : '', titleOf, senders, onOpen: (id) => { if (id !== activeId) openConv(id); } });
}

async function openConv(id, push = true) {
  msel.clear(); selPushed = false; thread.classList.remove('msel');
  activeId = id; msgs = []; hasMore = false; reads = new Map(); members = []; disSecs = null; layout.classList.add('open'); document.body.classList.add('in-conv');
  if (push) history.pushState({ c: id }, '');
  const c = curConv() || {}, grp = c.conv_type === 'group', nm = convName(c);
  lastSeenTxt = '';
  thread.innerHTML = `<header class="thead"><button class="ibtn back" aria-label="Kembali ke daftar chat">${icon('back')}</button><button class="row gap grow" id="hProfile" style="text-align:left;min-width:0">${grp ? `<span class="av" style="width:42px;height:42px">${icon('users')}</span>` : avatar(nm, c.other_avatar, 42)}<span class="grow"><span class="ell" style="display:block;font-weight:600">${nameWithBadge(nm, c.other_verified, 16, true, c.conv_type === 'group' ? null : c.other_id)}</span><span class="sub ell" id="hSub" style="display:block">${grp ? 'Grup' : ''}</span></span></button><button class="ibtn" id="hVoice" aria-label="${grp ? 'Panggilan suara grup' : 'Panggilan suara'}">${icon('phone')}</button><button class="ibtn" id="hVideo" aria-label="${grp ? 'Panggilan video grup' : 'Panggilan video'}">${icon('video')}</button><button class="ibtn" id="hMenu" aria-label="Menu percakapan">${icon('more')}</button></header><header class="msel-head hide" id="mselHead"><button class="ibtn" id="mselX" aria-label="Batal memilih pesan">${icon('x')}</button><h1 id="mselN" aria-live="polite">0 dipilih</h1><button class="ibtn" id="mselCopy" aria-label="Salin pesan">${icon('copy')}</button><button class="ibtn hide" id="mselEdit" aria-label="Edit pesan">${icon('edit')}</button><button class="ibtn hide" id="mselRep" aria-label="Laporkan pesan">${icon('flag')}</button><button class="ibtn danger" id="mselDel" aria-label="Hapus pesan">${icon('trash')}</button></header><div class="cl-banner" id="callBanner" hidden></div><div class="msgs" id="msgs" role="log" aria-live="polite" tabindex="0"><div class="empty">Memuat pesan…</div></div><form class="composer" id="cf"><button type="button" class="ibtn" id="attach" aria-label="Kirim foto atau video">${icon('clip')}</button><input type="file" id="mf" accept="${ACCEPT}" hidden><textarea class="inp" id="ci" rows="1" maxlength="4000" placeholder="Tulis pesan" aria-label="Tulis pesan"></textarea>${isPremium(me) ? `<button type="button" class="ibtn" id="schedBtn" aria-label="Jadwalkan pesan">${icon('clock')}</button>` : ''}<button class="send" id="sendBtn" aria-label="Kirim pesan" disabled>${icon('send')}</button></form><div class="blockbar hide" id="blk" role="status"></div>`;
  $('.back', thread).onclick = () => history.state?.c ? history.back() : closeConv();
  $('#hVoice').onclick = () => callFromChat('voice'); $('#hVideo').onclick = () => callFromChat('video'); paintCallBanner(); $('#attach').onclick = () => $('#mf').click(); $('#mf').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) sendMedia(f); };
  $('#hMenu').onclick = convMenu; $('#hProfile').onclick = showInfo;
  const ci = $('#ci'), sendBtn = $('#sendBtn');
  ci.oninput = () => { ci.style.height = 'auto'; ci.style.height = Math.min(ci.scrollHeight, 140) + 'px'; sendBtn.disabled = !ci.value.trim(); };
  ci.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer:fine)').matches) { e.preventDefault(); $('#cf').requestSubmit(); } };
  $('#cf').onsubmit = (e) => { e.preventDefault(); sendMsg(); };
  unbindDraft(); unbindDraft = draftBind(me, ci, id);   // draft Premium per percakapan (pulih saat dibuka lagi)
  if ($('#schedBtn')) $('#schedBtn').onclick = () => scheduleHere(ci.value.trim());
  $('#msgs').onclick = (e) => {
    if (mlpFired) { mlpFired = false; return; }
    const it = e.target.closest('.msg[data-m]');
    if (msel.size && it && !e.target.closest('[data-retry],[data-story],[data-older]')) return toggleMsel(it.dataset.m);   // saat memilih: ketuk = pilih/lepas
    const im = e.target.closest('.mm img'); if (im) return lightbox(im.src); onMsgClick(e);
  };
  $('#msgs').addEventListener('scroll', markRead, { passive: true });
  bindMsgSelect($('#msgs'));
  $('#mselX').onclick = () => exitMsel(); $('#mselCopy').onclick = copySelected; $('#mselDel').onclick = delSelected;
  $('#mselEdit').onclick = () => { const m = selRows()[0]; if (m && canEditMsg(m)) { exitMsel(); editMsg(m); } };
  $('#mselRep').onclick = () => { const m = selRows()[0]; if (m && m.sender_id !== me.id) { exitMsel(); reportModal(m.sender_id, prof.get(m.sender_id)?.display_name, m.id); } };
  renderList();
  try {
    const [{ data: mem }, { data: cv }] = await Promise.all([sb.from('conversation_members').select('user_id').eq('conversation_id', id), sb.from('conversations').select('disappear_secs').eq('id', id).maybeSingle()]);
    members = (mem || []).map((m) => m.user_id); disSecs = cv?.disappear_secs || null; paintSub();
    await ensureProfiles(members);
    await Promise.all([loadMsgs(id), loadReads(id)]);
    loadStoryRefs();
  } catch (e) { if (activeId === id) $('#msgs').innerHTML = `<div class="empty"><h3>Gagal memuat pesan</h3><p>${esc(errMsg(e))}</p><button class="btn" id="rt2" style="margin-top:12px">Coba lagi</button></div>`; $('#rt2') && ($('#rt2').onclick = () => openConv(id, false)); return; }
  paintBlock(); markRead(); if (!blocked.has(c.other_id)) setTimeout(() => ci.focus({ preventScroll: true }), 50);
  if (!grp && c.other_id) sb.rpc('get_last_seen', { target: c.other_id }).then(({ data }) => {
    if (activeId !== id || !$('#hSub')) return;
    lastSeenTxt = data ? lastSeenText(data) : ''; paintSub();
  });
}

function closeConv() {
  unbindDraft(); unbindDraft = () => {};
  msel.clear(); selPushed = false; thread.classList.remove('msel');
  activeId = null; msgs = []; layout.classList.remove('open'); document.body.classList.remove('in-conv');
  thread.innerHTML = `<div class="empty" style="margin:auto">${icon('chat', 44)}<h3>Pilih percakapan</h3><p>Atau tambahkan teman dengan ID ORVIX.</p></div>`; renderList();
}
addEventListener('popstate', () => {
  if (skipPop) { skipPop = false; return; }
  if (msel.size) { selPushed = false; exitMsel(true); return; }   // tombol Kembali saat memilih pesan hanya membatalkan pilihan
  if (activeId && !document.querySelector('.pscreen')) closeConv();
});

async function loadMsgs(id, older = false) {
  let qy = sb.from('messages').select('*').eq('conversation_id', id).order('created_at', { ascending: false }).limit(PAGE);
  const clr = curConv()?.cleared_at; if (clr) qy = qy.gt('created_at', clr);   // chat yang pernah dihapus hanya menampilkan pesan setelahnya
  if (older && msgs.length) qy = qy.lt('created_at', msgs.find((m) => !m._st).created_at);
  const { data, error } = await qy; if (error) throw error; if (activeId !== id) return;
  const rows = data.reverse(); hasMore = data.length === PAGE;
  await ensureProfiles(rows.map((r) => r.sender_id));
  const keep = msgs.filter((m) => m._st), map = new Map([...rows, ...msgs.filter((m) => !m._st)].map((m) => [m.id, m]));
  msgs = [...map.values(), ...keep].sort((x, y) => new Date(x.created_at) - new Date(y.created_at));
  render(older ? 'keep' : 'bottom');
}

/* ---------- status pesan (centang) ---------- */
async function loadReads(id) {
  const { data } = await sb.from('message_reads').select('user_id,last_read_at,last_delivered_at').eq('conversation_id', id);
  if (activeId !== id) return; reads = new Map((data || []).filter((r) => r.user_id !== me.id).map((r) => [r.user_id, { read: new Date(r.last_read_at).getTime(), del: r.last_delivered_at ? new Date(r.last_delivered_at).getTime() : NaN }])); render('auto');
}
// Satu centang = tersimpan di server. Dua abu-abu = diterima perangkat penerima. Dua biru = sudah dibaca. Pengirim tidak dihitung.
function tickState(m) {
  if (m._st === 'sending') return 'sending';
  const others = members.filter((u) => u !== me.id); if (!others.length) return 'sent';
  const t = new Date(m.created_at).getTime(), got = (u) => reads.get(u) || {};
  const read = others.filter((u) => got(u).read >= t).length, del = others.filter((u) => got(u).del >= t || got(u).read >= t).length;
  return read === others.length ? 'read' : del === others.length ? 'delivered' : 'sent';
}
const TICK_L = { sending: 'Mengirim', sent: 'Terkirim ke server', delivered: 'Diterima', read: 'Dibaca' };
function tickHTML(m) {
  const st = tickState(m); if (m._st === 'failed') return '';
  const grp = (curConv() || {}).conv_type === 'group', n = members.filter((u) => u !== me.id).length;
  const rd = grp && st !== 'sending' ? members.filter((u) => u !== me.id && (reads.get(u)?.read || 0) >= new Date(m.created_at).getTime()).length : 0;
  return `<span class="tick ${st}" role="img" aria-label="${TICK_L[st]}"${grp && !m._st ? ` data-seen="${m.id}"` : ''}>${st === 'sending' ? icon('clock', 14) : icon(st === 'sent' ? 'check' : 'checks', 15)}</span>${grp && !m._st && n ? `<span class="seen-n" data-seen="${m.id}">${rd}/${n}</span>` : ''}`;
}
function onReads({ new: r }) {
  if (!r || r.conversation_id !== activeId || r.user_id === me.id) return;
  reads.set(r.user_id, { read: new Date(r.last_read_at).getTime(), del: r.last_delivered_at ? new Date(r.last_delivered_at).getTime() : NaN }); render('auto');
}
async function seenModal(m) {
  const mt = new Date(m.created_at).getTime(), others = members.filter((u) => u !== me.id); await ensureProfiles(others);
  const row = (u, label) => { const p = prof.get(u) || {}; return `<div class="row gap">${avatar(p.display_name, p.avatar_url, 36)}<span class="grow">${esc(p.display_name || 'Anggota')}</span><span class="dim">${label}</span></div>`; };
  const rd = others.filter((u) => (reads.get(u)?.read || 0) >= mt), nr = others.filter((u) => !rd.includes(u));
  openModal({ title: 'Info pesan', html: `<p class="sec" style="margin:0 0 6px">Dibaca (${rd.length})</p><div class="col" style="gap:6px">${rd.map((u) => row(u, 'dibaca')).join('') || '<p class="dim">Belum ada.</p>'}</div><p class="sec" style="margin:14px 0 6px">Belum dibaca (${nr.length})</p><div class="col" style="gap:6px">${nr.map((u) => row(u, (reads.get(u)?.del || 0) >= mt ? 'diterima' : 'terkirim')).join('') || '<p class="dim">Semua sudah membaca.</p>'}</div>` });
}

/* ---------- kutipan story pada balasan ---------- */
async function loadStoryRefs() {
  const ids = [...new Set(msgs.filter((m) => m.story_id && !stInfo.has(m.story_id)).map((m) => m.story_id))]; if (!ids.length) return;
  const { data } = await sb.rpc('orvix_story_status', { ids }); const ok = new Map((data || []).map((x) => [x.id, x]));
  ids.forEach((i) => stInfo.set(i, ok.get(i) || null));
  const need = (data || []).map((x) => (x.kind === 'video' ? x.thumb_path : x.kind === 'image' ? x.media_path : null)).filter(Boolean);
  if (need.length) { const { data: sg } = await sb.storage.from('stories').createSignedUrls(need, 3600); (sg || []).forEach((x) => x.signedUrl && sUrls.set(x.path, x.signedUrl)); }
  render('auto');
}
function quoteHTML(m) {
  if (!m.story_id) return ''; const i = stInfo.get(m.story_id);
  if (i === undefined) return `<div class="sq"><span class="sq-b"></span><span class="grow"><b>Membalas story</b><small>Memuat…</small></span></div>`;
  const path = i && (i.kind === 'video' ? i.thumb_path : i.kind === 'image' ? i.media_path : null), u = path && sUrls.get(path);
  const th = i ? (u ? `<img src="${esc(u)}" alt="">` : `<span class="sq-t sbg${i.bg_index || 0}"></span>`) : `<span class="sq-t gone">${icon('clock', 18)}</span>`;
  const own = m.story_owner_id === me.id ? 'Story kamu' : 'Story ' + esc(prof.get(m.story_owner_id)?.display_name || '');
  return `<div class="sq ${i ? '' : 'off'}">${th}<span class="grow"><b>Membalas ${own}</b><small class="ell">${i ? esc(m.story_text || (i.kind === 'video' ? 'Video' : i.kind === 'image' ? 'Foto' : 'Teks')) : 'Story sudah tidak tersedia'}</small></span>${i ? `<button class="btn sm" data-story="${m.story_id}">Lihat</button>` : ''}</div>`;
}

function render(mode = 'auto') {
  const el = $('#msgs'); if (!el) return; const c = curConv() || {}, grp = c.conv_type === 'group';
  const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120, prevH = el.scrollHeight;
  let html = hasMore ? '<button class="btn sm older" data-older>Muat pesan lama</button>' : '', last = '';
  if (!msgs.length) html += `<div class="empty">${icon('chat', 36)}<p>Belum ada pesan. Sapa duluan.</p></div>`;
  msgs.forEach((m, i) => {
    const d = new Date(m.created_at).toDateString(); if (d !== last) { html += `<div class="day">${fmtDay(m.created_at)}</div>`; last = d; }
    const mine = m.sender_id === me.id;
    if (m.message_type === 'system') { html += `<div class="sysmsg">${icon('timer', 14)} ${esc(mine ? 'Kamu' : prof.get(m.sender_id)?.display_name || 'Anggota')} ${esc(m.content)}</div>`; return; }
    if (m.deleted_at) { html += `<div class="msg gone ${mine ? 'out' : 'in'}">${icon('ban', 14)} <span>${mine ? 'Kamu menghapus pesan ini' : 'Pesan ini telah dihapus'}</span><span class="meta">${fmtTime(m.created_at)}</span></div>`; return; }
    const who = grp && !mine ? `<div class="who">${esc(prof.get(m.sender_id)?.display_name || 'Anggota')}</div>` : '';
    const picked = msel.has(m.id);
    html += `<div class="msg ${mine ? 'out' : 'in'} ${m._st || ''}${picked ? ' sel' : ''}" data-m="${m.id}"${msel.size ? ` role="checkbox" aria-checked="${picked}"` : ''}>${who}${quoteHTML(m)}${mediaHTML(m)}${isPlaceholder(m) ? '' : esc(m.content)}<span class="meta">${m.expires_at ? icon('timer', 12) + ' ' : ''}${fmtTime(m.created_at)}${m.edited_at ? ' · diedit' : ''}${mine ? tickHTML(m) : ''}${m._st === 'failed' ? ' · gagal' : ''}${m._st === 'failed' ? ` <button class="btn sm" data-retry="${m.id}" style="min-height:26px;padding:0 10px">Coba lagi</button>` : ''}</span></div>`;
  });
  el.innerHTML = html; hydrate(el).then(() => { if (mode === 'bottom' || near) el.scrollTop = el.scrollHeight; });
  if (mode === 'bottom' || (mode === 'auto' && near)) el.scrollTop = el.scrollHeight; else if (mode === 'keep') el.scrollTop = el.scrollHeight - prevH;
}

async function onMsgClick(e) {
  if (e.target.closest('[data-older]')) { const b = e.target.closest('[data-older]'); setBusy(b, true); try { await loadMsgs(activeId, true); } catch (x) { toast(errMsg(x), 'error'); setBusy(b, false); } return; }
  const rt = e.target.closest('[data-retry]'); if (rt) { const m = msgs.find((x) => x.id === rt.dataset.retry); if (m) { m._st = 'sending'; render(); insertMsg(m); } return; }
  const sb2 = e.target.closest('[data-story]'); if (sb2) { location.href = '/updates?story=' + sb2.dataset.story; return; }
  const sn = e.target.closest('[data-seen]'); if (sn) { const mm = msgs.find((x) => x.id === sn.dataset.seen); if (mm) seenModal(mm); return; }
  const el = e.target.closest('[data-m]'); if (!el) return; const m = msgs.find((x) => x.id === el.dataset.m); if (!m || m._st) return;
  const mine = m.sender_id === me.id, age = Date.now() - new Date(m.created_at), canEdit = mine && !m.media_path && age < editMs(), canDel = mine && age < DEL_MS;
  const sh = openModal({ title: 'Pesan', sheet: true, html: `<div class="col">${m.media_path ? '' : `<button class="btn" data-a="copy">${icon('copy')} Salin</button>`}${canEdit ? `<button class="btn" data-a="edit">${icon('edit')} Edit (maks. ${isPremium(me) ? '1 jam' : '15 menit'})</button>` : ''}${mine ? (canDel ? `<button class="btn danger" data-a="del">${icon('trash')} Hapus untuk semua</button>` : `<p class="hint" style="text-align:center">Hapus untuk semua hanya tersedia dalam 1 jam setelah pesan dikirim.</p>`) : `<button class="btn" data-a="rep">${icon('flag')} Laporkan pesan</button>`}</div>` });
  sh.el.onclick = async (ev) => {
    const a = ev.target.closest('[data-a]')?.dataset.a; if (!a) return; sh.close();
    if (a === 'copy') copyText(m.content);
    if (a === 'edit') editMsg(m);
    if (a === 'rep') reportModal(m.sender_id, prof.get(m.sender_id)?.display_name, m.id);
    if (a === 'del' && await confirmDialog({ title: 'Hapus pesan?', message: 'Pesan akan diganti menjadi "Pesan ini telah dihapus" untuk semua anggota percakapan.', confirmText: 'Hapus', danger: true })) {
      await removeMedia(m);
      const { data, error } = await sb.from('messages').update({ deleted_at: new Date().toISOString() }).eq('id', m.id).select().single();
      if (error) return toast(errMsg(error), 'error'); applyUpdate(data); refreshList();
    }
  };
}
function editMsg(m) {
  const ed = openModal({ title: 'Edit pesan', html: `<div class="field"><textarea class="inp" id="et" maxlength="4000">${esc(m.content)}</textarea></div><div class="row end gap"><button class="btn ghost" data-x2>Batal</button><button class="btn primary" id="es">Simpan</button></div>` });
  $('[data-x2]', ed.el).onclick = ed.close;
  $('#es', ed.el).onclick = async (ev) => {
    const t = $('#et', ed.el).value.trim(); if (!t) return toast('Pesan tidak boleh kosong', 'error'); if (t === m.content) return ed.close();
    setBusy(ev.currentTarget, true);
    const { data, error } = await sb.from('messages').update({ content: t }).eq('id', m.id).select().single();
    if (error) { setBusy(ev.currentTarget, false); return toast(errMsg(error), 'error'); }
    applyUpdate(data); ed.close(); refreshList();
  };
}
function applyUpdate(row) {
  const i = msgs.findIndex((x) => x.id === row.id);
  if (i >= 0) { msgs[i] = row; if (row.deleted_at && msel.delete(row.id)) { if (msel.size) paintMsel(); else exitMsel(); } render('auto'); }
}

/* ---------- pilih pesan dengan tekan lama (seperti memilih chat) ---------- */
const canDelMsg = (m) => m.sender_id === me.id && Date.now() - new Date(m.created_at) < DEL_MS;
const canEditMsg = (m) => m.sender_id === me.id && !m.media_path && !m._st && Date.now() - new Date(m.created_at) < editMs();
const selectable = (m) => !!m && !m._st && !m.deleted_at && m.message_type !== 'system';
const selRows = () => msgs.filter((m) => msel.has(m.id));
function paintMsel() {
  const on = msel.size > 0, rows = selRows(), one = rows.length === 1 ? rows[0] : null, box = $('#msgs');
  thread.classList.toggle('msel', on);
  $('.thead', thread)?.classList.toggle('hide', on); $('#mselHead')?.classList.toggle('hide', !on);
  if (box) $$('.msg[data-m]', box).forEach((n) => {
    const s = msel.has(n.dataset.m); n.classList.toggle('sel', s);
    if (on) { n.setAttribute('role', 'checkbox'); n.setAttribute('aria-checked', s); } else { n.removeAttribute('role'); n.removeAttribute('aria-checked'); }
  });
  if (!on) return;
  $('#mselN').textContent = msel.size + ' dipilih';
  $('#mselCopy').classList.toggle('hide', !rows.some((m) => !m.media_path && m.content));
  $('#mselEdit').classList.toggle('hide', !(one && canEditMsg(one)));
  $('#mselRep').classList.toggle('hide', !(one && one.sender_id !== me.id));
  $('#mselDel').setAttribute('aria-disabled', !rows.every(canDelMsg));
}
function selectMsg(id) {
  if (!selectable(msgs.find((m) => m.id === id))) return;
  if (!msel.size && !selPushed) { history.pushState({ c: activeId, sel: 1 }, ''); selPushed = true; }   // tombol Kembali = batal pilih
  if (!msel.has(id)) { msel.add(id); navigator.vibrate?.(12); }
  paintMsel();
}
function toggleMsel(id) {
  if (!msel.has(id)) return selectMsg(id);
  msel.delete(id); msel.size ? paintMsel() : exitMsel();
}
function exitMsel(fromPop = false) {
  msel.clear(); paintMsel();
  if (!fromPop && selPushed) { selPushed = false; skipPop = true; history.back(); }
  selPushed = false;
}
function bindMsgSelect(box) {
  let x0 = 0, y0 = 0; const stop = () => clearTimeout(mlpT);
  box.addEventListener('pointerdown', (e) => {
    const it = e.target.closest('.msg[data-m]'); if (!it || e.button > 0 || e.target.closest('button,a,[data-seen]')) return;
    x0 = e.clientX; y0 = e.clientY; clearTimeout(mlpT);
    mlpT = setTimeout(() => { if (selectable(msgs.find((m) => m.id === it.dataset.m))) { mlpFired = true; selectMsg(it.dataset.m); setTimeout(() => { mlpFired = false; }, 700); } }, 420);
  });
  box.addEventListener('pointermove', (e) => { if (Math.abs(e.clientX - x0) > 8 || Math.abs(e.clientY - y0) > 8) stop(); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => box.addEventListener(ev, stop));
  box.addEventListener('scroll', stop, { passive: true });
  box.addEventListener('contextmenu', (e) => { const it = e.target.closest('.msg[data-m]'); if (it) { e.preventDefault(); mlpFired = true; selectMsg(it.dataset.m); setTimeout(() => { mlpFired = false; }, 700); } });
}
function copySelected() {
  const t = selRows().filter((m) => !m.media_path && m.content).map((m) => m.content).join('\n'); if (!t) return;
  copyText(t); exitMsel();
}
async function delSelected() {
  const rows = selRows(), n = rows.length; if (!n) return;
  if (!rows.every((m) => m.sender_id === me.id)) return toast(n > 1 ? 'Kamu hanya bisa menghapus pesanmu sendiri. Lepas pilihan pesan orang lain.' : 'Kamu hanya bisa menghapus pesanmu sendiri.', 'error');
  if (!rows.every(canDelMsg)) return toast(n > 1 ? 'Sebagian pesan sudah lewat 1 jam dan tidak bisa dihapus untuk semua.' : 'Hapus untuk semua hanya tersedia dalam 1 jam setelah pesan dikirim.', 'error');
  if (!(await confirmDialog({ title: n > 1 ? `Hapus ${n} pesan?` : 'Hapus pesan ini?', message: `${n > 1 ? `${n} pesan akan` : 'Pesan akan'} diganti menjadi "Pesan ini telah dihapus" untuk semua anggota percakapan.`, confirmText: 'Hapus', danger: true }))) return;
  const cid = activeId; let ok = 0, fail = null;
  for (const m of rows) {
    try {
      await removeMedia(m);
      const { data, error } = await sb.from('messages').update({ deleted_at: new Date().toISOString() }).eq('id', m.id).select().single();
      if (error) throw error;
      if (cid === activeId) { const i = msgs.findIndex((x) => x.id === data.id); if (i >= 0) msgs[i] = data; } ok++;
    } catch (e) { fail = e; }
  }
  if (cid !== activeId) return refreshList();
  exitMsel(); render('auto'); refreshList();
  if (!fail) return toast(n > 1 ? `${n} pesan dihapus` : 'Pesan dihapus', 'success');
  const why = /multiple \(or no\) rows|PGRST116|row-level security|1 jam/i.test(errMsg(fail)) ? 'Pesan sudah lewat 1 jam atau sudah dihapus.' : dbErr(fail, '13b-hapus-pesan-chat.sql');
  toast(ok ? `${ok} pesan dihapus, ${n - ok} gagal. ${why}` : `Pesan tidak bisa dihapus. ${why}`, 'error');
}

/* ---------- kirim ---------- */
function sendMsg() {
  const ci = $('#ci'), text = ci.value.trim(); if (!text || text.length > 4000 || !activeId) return;
  ci.value = ''; ci.style.height = 'auto'; $('#sendBtn').disabled = true; draftClear(me, activeId);
  const tmp = { id: 'tmp-' + ++seq, conversation_id: activeId, sender_id: me.id, content: text, created_at: new Date().toISOString(), _st: 'sending' };
  msgs.push(tmp); render('bottom'); insertMsg(tmp);
}
async function insertMsg(tmp) {
  const { data, error } = await sb.from('messages').insert({ conversation_id: tmp.conversation_id, sender_id: me.id, content: tmp.content }).select().single();
  if (tmp.conversation_id !== activeId) { if (!error) refreshList(); return; }
  if (error) { tmp._st = 'failed'; render('auto'); return toast(sendErr(error), 'error'); }
  const cc = curConv(); if (cc?.conv_type === 'direct' && cc.other_id && !savedOnce.has(cc.other_id)) { savedOnce.add(cc.other_id); saveContact(cc.other_id, 'chat'); }
  msgs = msgs.filter((m) => m !== tmp); if (!msgs.some((m) => m.id === data.id)) msgs.push(data);
  msgs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)); render('bottom'); refreshList();
}
async function sendMedia(file) {
  const id = activeId, tmp = { id: 'tmp-' + ++seq, conversation_id: id, sender_id: me.id, content: 'Mengunggah…', created_at: new Date().toISOString(), _st: 'sending' };
  msgs.push(tmp); render('bottom');
  try {
    const row = await sendMessage({ conv: id, me: me.id, file, onProgress: (f) => { tmp.content = `Mengunggah ${Math.round(f * 100)}%`; const el = $(`[data-m="${tmp.id}"]`); if (el?.firstChild) el.firstChild.textContent = tmp.content; } });
    if (id !== activeId) return refreshList();
    msgs = msgs.filter((m) => m !== tmp); if (!msgs.some((m) => m.id === row.id)) msgs.push(row); msgs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)); render('bottom'); refreshList();
  } catch (e) { msgs = msgs.filter((m) => m !== tmp); render('auto'); toast(sendErr(e), 'error'); }
}
const savedOnce = new Set();
const sendErr = (e) => (/row-level security|violates|permission denied/i.test(errMsg(e)) ? 'Pesan tidak terkirim. Kamu tidak bisa mengirim pesan ke percakapan ini.' : errMsg(e));
const saveContact = (uid, src) => sb.rpc('orvix_save_contact', { target: uid, src }).then(() => {}, () => {});
const callCtx = (c) => ({ isGroup: c.conv_type === 'group', title: convName(c), avatar: c.other_avatar, otherId: c.other_id });
async function callFromChat(kind) {
  const c = curConv(); if (!c) return;
  if (c.conv_type !== 'group' && blocked.has(c.other_id)) return toast('Buka blokir pengguna ini untuk menelepon.', 'error');
  if (activeSession()) return toast('Kamu masih dalam panggilan.', 'error');
  try { await startCall(c.conv_id, kind, callCtx(c)); } catch (e) { if (!e.shown) toast(e.message || 'Tidak bisa memulai panggilan.', 'error'); }
}
function paintCallBanner() {
  const el = $('#callBanner'); if (!el) return;
  const row = activeId && openCalls().get(activeId), act = activeSession();
  const show = row && !(act && act.callId === row.call_id) && (row.scope === 'group' || row.my_state === 'joined');
  el.hidden = !show; if (!show) return;
  const k = row.kind === 'video' ? 'video' : 'suara';
  el.innerHTML = `${icon(row.kind === 'video' ? 'video' : 'phone', 18)}<span>Panggilan ${k}${row.scope === 'group' ? ' grup' : ''} sedang berlangsung${row.joined_count ? ' · ' + row.joined_count + ' peserta' : ''}</span><button class="btn primary" id="callJoin">${row.my_state === 'joined' ? 'Kembali' : 'Gabung'}</button>`;
  $('#callJoin').onclick = async () => { const c = curConv(); if (!c) return; try { await joinCall({ callId: row.call_id, convId: row.conversation_id, kind: row.kind, scope: row.scope, ctx: callCtx(c) }); } catch (e) { if (!e.shown) toast(e.message || 'Tidak bisa bergabung ke panggilan.', 'error'); } };
}
['open', 'session', 'session-end'].forEach((ev) => callBus.on(ev, () => paintCallBanner()));
const atBottom = () => { const el = $('#msgs'); return !!el && el.scrollHeight - el.scrollTop - el.clientHeight < 90; };
// Dibaca hanya jika tab terlihat, thread terbuka, dan pesan terbaru benar-benar ada di layar (sudah digulir ke bawah)
const markRead = debounce(() => { if (activeId && !document.hidden && layout.classList.contains('open') && atBottom()) sb.rpc('mark_read', { conv: activeId }).then(() => { const c = curConv(); if (c) { c.unread = 0; renderList(); } }); }, 300);
const dlv = new Map();
const markDelivered = (id) => { if (Date.now() - (dlv.get(id) || 0) < 4000) return; dlv.set(id, Date.now()); sb.rpc('orvix_mark_delivered', { conv: id }).then(() => {}, () => {}); };
document.addEventListener('visibilitychange', markRead);
setInterval(() => { const n = msgs.length; msgs = msgs.filter((m) => !m.expires_at || new Date(m.expires_at) > Date.now()); if (msgs.length !== n) { [...msel].forEach((i) => { if (!msgs.some((m) => m.id === i)) msel.delete(i); }); msel.size ? paintMsel() : exitMsel(); render('auto'); refreshList(); } }, 20000);

/* ---------- Realtime ---------- */
function notify(title, body) {
  if (pushActiveLocal(me.id)) return;   // Web Push aktif: notifikasi datang dari service worker (tanpa dobel)
  if (localStorage.getItem('orvix_notif') === '1' && 'Notification' in window && Notification.permission === 'granted') { try { new Notification(title, { body: body.slice(0, 120), icon: '/assets/mark.png' }); } catch { /* abaikan */ } }
}
async function onInsert({ new: m }) {
  if (m.sender_id !== me.id && m.message_type !== 'system') markDelivered(m.conversation_id);   // pesan sudah sampai di perangkat ini
  if (m.conversation_id === activeId) {
    if (!msgs.some((x) => x.id === m.id)) { await ensureProfiles([m.sender_id]); msgs.push(m); msgs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)); render('auto'); }
    if (m.sender_id !== me.id) { markRead(); if (m.story_id) loadStoryRefs(); if (document.hidden && m.message_type !== 'system') notify(convName(curConv() || {}), m.content); }
  } else if (m.sender_id !== me.id) {
    const c = convs.find((x) => x.conv_id === m.conversation_id); notify(c ? convName(c) : 'Pesan baru', m.content);
  }
  refreshList();
}
function onUpdate({ new: m }) { if (m.conversation_id === activeId) applyUpdate(m); refreshList(); }
const refreshReq = debounce(async () => {
  try { const fr = await fetchFriendships(me.id); const n = fr.filter((f) => f.status === 'pending' && f.incoming).length; const b = $('#reqN'); b.textContent = n; b.classList.toggle('hide', !n); } catch { /* abaikan */ }
}, 300);
track(sb.channel('inbox-' + me.id)
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, onInsert)
  .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, onUpdate)
  .on('postgres_changes', { event: '*', schema: 'public', table: 'message_reads' }, onReads)
  .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversations' }, ({ new: c }) => { if (c.id === activeId) { disSecs = c.disappear_secs || null; paintSub(); } })
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'conversation_members', filter: `user_id=eq.${me.id}` }, () => refreshList())
  .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, () => refreshReq())
  .subscribe((s) => { $('#conn').classList.toggle('hide', s === 'SUBSCRIBED' || s === 'CLOSED'); }));

/* ---------- menu percakapan ---------- */
function convMenu() {
  const c = curConv() || {}, grp = c.conv_type === 'group';
  const m = openModal({ title: grp ? 'Grup' : 'Percakapan', sheet: true, html: `<div class="col"><button class="btn" data-a="info">${icon('user')} ${grp ? 'Anggota grup' : 'Lihat profil'}</button><button class="btn" data-a="dis">${icon('timer')} Pesan sementara <span class="dim" style="margin-left:auto">${DIS[disSecs || 0]}</span></button>${grp ? `<button class="btn" data-a="share">${icon('link')} Bagikan link grup</button><button class="btn danger" data-a="leave">${icon('logout')} Keluar grup</button>` : `<button class="btn" data-a="report">${icon('flag')} Laporkan</button>${blocked.has(c.other_id) ? `<button class="btn" data-a="unblock">${icon('unlock')} Buka blokir</button>` : `<button class="btn danger" data-a="block">${icon('ban')} Blokir</button>`}`}<button class="btn" data-a="search">${icon('search')} Cari pesan</button><button class="btn" data-a="sched">${icon('clock')} ${isPremium(me) ? 'Jadwalkan pesan' : 'Pesan terjadwal'} ${isPremium(me) ? '' : '<span class="pill prem" style="margin-left:auto">Premium</span>'}</button><button class="btn" data-a="export">${icon('download')} Ekspor chat ${isPremium(me) ? '' : '<span class="pill prem" style="margin-left:auto">Premium</span>'}</button></div>` });
  m.el.onclick = async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return; m.close();
    if (a === 'info') showInfo();
    if (a === 'dis') disappearModal();
    if (a === 'share') shareInvite(c.conv_id, c.title || 'Grup', 'grup');
    if (a === 'report') reportModal(c.other_id, c.other_name);
    if (a === 'block') blockCurrent(c);
    if (a === 'unblock') unblockCurrent(c);
    if (a === 'search') searchHere(false);
    if (a === 'sched') isPremium(me) ? scheduleHere($('#ci')?.value.trim() || '') : premiumInfo('Pesan terjadwal');
    if (a === 'export') exportChat(c);
    if (a === 'leave') leaveCurrent(c);
  };
}
async function loadBlocked() {
  let r = await sb.rpc('orvix_list_blocked'); if (r.error) r = await sb.from('blocked_users').select('blocked_id');
  blocked = new Set((r.data || []).map((x) => x.user_id || x.blocked_id));
}
function paintBlock() {
  const c = curConv() || {}, bar = $('#blk'), cf = $('#cf'); if (!bar || !cf) return;
  const b = c.conv_type !== 'group' && !!c.other_id && blocked.has(c.other_id);
  cf.classList.toggle('hide', b); bar.classList.toggle('hide', !b);
  if (b) { bar.innerHTML = `${icon('ban', 18)}<span class="grow">Kamu memblokir <b>${esc(convName(c))}</b>. Buka blokir untuk mengirim pesan lagi.</span><button class="btn sm primary" data-ub>Buka blokir</button>`; $('[data-ub]', bar).onclick = () => unblockCurrent(c); }
}
async function blockCurrent(c, done) {
  if (!(await confirmDialog({ title: `Blokir ${c.other_name}?`, message: 'Kalian tidak bisa saling mengirim pesan dan pertemanan akan dihapus. Kamu bisa membuka blokir kapan saja dari menu chat atau Profil.', confirmText: 'Blokir', danger: true }))) return;
  const { error } = await sb.rpc('block_user', { target: c.other_id }); if (error) return toast(dbErr(error, '13a-blokir.sql'), 'error');
  blocked.add(c.other_id); toast('Pengguna diblokir', 'success'); done?.(); paintBlock(); renderList(); refreshReq();
}
async function unblockCurrent(c, done) {
  const { error } = await sb.rpc('unblock_user', { target: c.other_id }); if (error) return toast(dbErr(error, '13a-blokir.sql'), 'error');
  blocked.delete(c.other_id); toast('Blokir dibuka', 'success'); done?.(); paintBlock(); renderList(); setTimeout(() => $('#ci')?.focus(), 60);
}
/* ---------- ekspor chat (Premium) ---------- */
async function exportChat(c) {
  if (!isPremium(me)) return openPremiumHub(me);
  toast('Menyiapkan ekspor…'); const rows = []; let before = null;
  for (let i = 0; i < 20; i++) {
    let qy = sb.from('messages').select('created_at,sender_id,content,message_type,deleted_at').eq('conversation_id', c.conv_id).order('created_at', { ascending: false }).limit(1000);
    if (before) qy = qy.lt('created_at', before); if (c.cleared_at) qy = qy.gt('created_at', c.cleared_at);
    const { data, error } = await qy; if (error) return toast(errMsg(error), 'error'); rows.push(...data); if (data.length < 1000) break; before = data[data.length - 1].created_at;
  }
  await ensureProfiles([...new Set(rows.map((r) => r.sender_id))]); rows.reverse();
  const f = (d) => new Intl.DateTimeFormat('id-ID', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(d));
  const body = rows.map((r) => { const who = r.sender_id === me.id ? 'Kamu' : prof.get(r.sender_id)?.display_name || 'Anggota'; const t = r.message_type === 'system' ? `* ${r.content}` : r.deleted_at ? '(pesan dihapus)' : r.message_type === 'image' ? '[Foto] ' + (r.content || '') : r.message_type === 'video' ? '[Video] ' + (r.content || '') : r.content; return `[${f(r.created_at)}] ${who}: ${t}`; }).join('\n');
  const blob = new Blob([`Ekspor chat ORVIX: ${convName(c)}\nDiekspor ${f(Date.now())} · ${rows.length} pesan\n\n${body}\n`], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `chat-orvix-${convName(c).replace(/[^\w-]+/g, '_')}.txt`; document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  toast('Chat diekspor', 'success');
}
async function leaveCurrent(c, done) {
  if (!(await confirmDialog({ title: 'Keluar dari grup?', message: 'Kamu tidak akan menerima pesan grup lagi.', confirmText: 'Keluar', danger: true }))) return;
  const { error } = await sb.rpc('leave_group', { conv: c.conv_id }); if (error) return toast(errMsg(error), 'error');
  done?.(); setTimeout(() => { if (history.state?.c) history.back(); else closeConv(); loadConvs(); }, 220);
}
const joinedText = (d) => (d ? new Intl.DateTimeFormat('id-ID', { month: 'long', year: 'numeric' }).format(new Date(d)) : '');
async function showInfo() {
  const c = curConv(); if (!c) return;
  if (c.conv_type === 'group') {
    const { data } = await sb.from('conversation_members').select('user_id,role').eq('conversation_id', c.conv_id); await ensureProfiles((data || []).map((d) => d.user_id));
    const mem = (data || []).map((d) => { const p = prof.get(d.user_id) || {}; return { id: d.user_id, name: p.display_name || 'Anggota', avatar: p.avatar_url, verified: p.is_verified, username: p.username, owner: d.role === 'owner' }; }).sort((a, b) => b.owner - a.owner);
    return profileScreen({ name: c.title || 'Grup', group: true, members: mem, actions: [
      { label: 'Link grup', icon: 'link', run: () => shareInvite(c.conv_id, c.title || 'Grup', 'grup') },
      { label: 'Pesan sementara', icon: 'timer', run: () => disappearModal() },
      { label: 'Keluar grup', icon: 'logout', tone: 'danger', run: (close) => leaveCurrent(c, close) }] });
  }
  const base = prof.get(c.other_id) || { display_name: c.other_name, username: c.other_username, avatar_url: c.other_avatar, is_verified: c.other_verified };
  const PC = 'display_name,username,orvix_id,avatar_url,status_text,is_verified,created_at';
  const prq = async () => { let r = await sb.from('profiles').select(PC + ',banner_url').eq('id', c.other_id).maybeSingle(); if (r.error) r = await sb.from('profiles').select(PC).eq('id', c.other_id).maybeSingle(); return r; };   // banner_url ada setelah SQL 12h
  const [{ data: pr }, { data: ls }] = await Promise.all([prq(), sb.rpc('get_last_seen', { target: c.other_id })]);
  const p = { ...base, ...(pr || {}) };
  profileScreen({ name: p.display_name, username: p.username, orvixId: p.orvix_id, avatarUrl: p.avatar_url, bannerUrl: p.banner_url, verified: p.is_verified, userId: c.other_id, bio: p.status_text, joined: joinedText(p.created_at), seen: ls ? lastSeenText(ls) : '', actions: [
    { label: 'Pesan sementara', icon: 'timer', run: () => disappearModal() },
    { label: 'Laporkan', icon: 'flag', run: () => reportModal(c.other_id, c.other_name) },
    blocked.has(c.other_id) ? { label: 'Buka blokir', icon: 'unlock', run: (close) => unblockCurrent(c, close) } : { label: 'Blokir', icon: 'ban', tone: 'danger', run: (close) => blockCurrent(c, close) }] });
}
async function disappearModal() {
  const c = curConv() || {}, grp = c.conv_type === 'group';
  let owner = !grp; if (grp) { const { data } = await sb.from('conversation_members').select('role').eq('conversation_id', activeId).eq('user_id', me.id).maybeSingle(); owner = data?.role === 'owner'; }
  const m = openModal({ title: 'Pesan sementara', sheet: true, html: `<p class="muted" style="margin-bottom:10px">Pesan baru akan terhapus otomatis dari server setelah durasi yang dipilih. Pesan yang sudah ada tidak berubah. Ini tidak mencegah penerima menyimpan salinan atau tangkapan layar.</p>${owner ? '' : '<p class="alert warn" style="margin-bottom:10px">Hanya pemilik grup yang dapat mengubah pengaturan ini.</p>'}<div class="vis col" role="radiogroup" aria-label="Durasi pesan sementara" style="gap:8px">${Object.entries(DIS).map(([k, v]) => `<button class="btn ${(disSecs || 0) === +k ? 'primary' : ''}" role="radio" aria-checked="${(disSecs || 0) === +k}" data-d="${k}" ${owner ? '' : 'disabled'}>${v}</button>`).join('')}</div>` });
  m.el.onclick = async (e) => {
    const b = e.target.closest('[data-d]'); if (!b || b.disabled) return; setBusy(b, true);
    const { error } = await sb.rpc('orvix_set_disappearing', { conv: activeId, secs: +b.dataset.d });
    if (error) { setBusy(b, false); return toast(errMsg(error), 'error'); }
    disSecs = +b.dataset.d || null; paintSub(); m.close(); toast(disSecs ? 'Pesan sementara aktif: ' + DIS[disSecs] : 'Pesan sementara dinonaktifkan', 'success');
  };
}
const REASONS = [['spam', 'Spam'], ['scam', 'Penipuan'], ['doxxing', 'Penyebaran informasi pribadi (doxxing)'], ['abuse', 'Pelecehan atau perundungan'], ['threat', 'Ancaman'], ['inappropriate', 'Konten tidak pantas'], ['impersonation', 'Akun palsu atau penyamaran'], ['other', 'Lainnya']];
function reportModal(uid, name, msgId = null) {
  const m = openModal({ title: `Laporkan ${name || 'pengguna'}`, html: `<div class="field"><label for="rr">Kategori</label><select class="inp" id="rr">${REASONS.map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div><div class="field"><label for="rd">Keterangan${msgId ? ' (opsional)' : ''}</label><textarea class="inp" id="rd" maxlength="1000" placeholder="Jelaskan apa yang terjadi"></textarea></div>${msgId ? `<p class="alert info" style="margin-bottom:12px">Pesan yang kamu pilih dilampirkan sebagai bukti. Hanya tim moderator yang dapat melihatnya.</p>` : ''}<p class="hint" style="margin-bottom:12px">Identitasmu dirahasiakan dari pengguna yang dilaporkan. Satu laporan tidak otomatis membuat akun ditangguhkan.</p><p class="err" id="re" role="alert"></p><div class="row end gap"><button class="btn ghost" data-x2>Batal</button><button class="btn primary" id="rs">Kirim laporan</button></div>` });
  $('[data-x2]', m.el).onclick = m.close;
  $('#rs', m.el).onclick = async (e) => {
    setBusy(e.currentTarget, true); $('#re', m.el).textContent = '';
    const { error } = await sb.rpc('orvix_submit_report', { p_user: uid, p_reason: $('#rr', m.el).value, p_details: $('#rd', m.el).value.trim() || null, p_message: msgId });
    if (error) { setBusy(e.currentTarget, false); return ($('#re', m.el).textContent = errMsg(error)); } toast('Laporan terkirim. Terima kasih.', 'success'); m.close();
  };
}

/* ---------- teman ---------- */
async function startChat(uid, modals = []) {
  const { data, error } = await sb.rpc('start_direct_chat', { target: uid }); if (error) return toast(errMsg(error), 'error');
  modals.forEach((m) => m.close()); await loadConvs(); openConv(data); saveContact(uid, 'chat');
}
function addFriendModal(prefill = '') {
  const m = openModal({ title: 'Tambah teman', html: `<form id="sf"><div class="field"><label for="sid">ID ORVIX (8 angka)</label><div class="row gap"><input class="inp" id="sid" inputmode="numeric" maxlength="8" pattern="[0-9]*" placeholder="contoh 48210377" value="${esc(prefill)}"><button class="btn primary" id="sgo">Cari</button></div></div></form><div id="sres"></div>` });
  const res = $('#sres', m.el);
  const search = async () => {
    const id = $('#sid', m.el).value.trim(); if (!/^\d{8}$/.test(id)) { res.innerHTML = '<p class="err">ID ORVIX terdiri dari 8 angka.</p>'; return; }
    setBusy($('#sgo', m.el), true); const { data, error } = await sb.rpc('find_user_by_orvix_id', { q: id }); setBusy($('#sgo', m.el), false);
    if (error) { res.innerHTML = `<p class="err">${esc(errMsg(error))}</p>`; return; }
    const u = data?.[0]; if (!u) { res.innerHTML = '<div class="empty" style="padding:20px"><p>ID tidak ditemukan.</p></div>'; return; }
    if (u.relation !== 'self') saveContact(u.id, 'search');
    let open = false; if (u.relation === 'none' || u.relation === 'pending_out' || u.relation === 'pending_in') { const { data: pp } = await sb.from('profiles').select('who_can_message').eq('id', u.id).maybeSingle(); open = pp?.who_can_message === 'anyone'; }
    const chatBtn = open ? '<button class="btn sm" data-chat>Chat</button>' : '';
    const act = { self: '<span class="dim">Ini ID kamu</span>', friend: '<button class="btn sm primary" data-chat>Chat</button>', pending_out: chatBtn + '<span class="dim">Permintaan terkirim</span>', pending_in: chatBtn + '<button class="btn sm primary" data-acc>Terima</button>', none: chatBtn + '<button class="btn sm primary" data-req>Tambah teman</button>' }[u.relation];
    const note = ['none', 'pending_out', 'pending_in'].includes(u.relation) && !open ? '<p class="hint" style="margin-top:10px">Pengguna ini hanya menerima chat dari teman. Kirim permintaan pertemanan; chat bisa dimulai setelah diterima.</p>' : '';
    res.innerHTML = `<div class="card row gap">${avatar(u.display_name, u.avatar_url, 48)}<span class="grow">${nameWithBadge(u.display_name, u.is_verified, 15, true, u.id)}<br><span class="dim">@${esc(u.username)}</span></span>${act}</div>${note}`;
    $('[data-req]', res)?.addEventListener('click', async (e) => { setBusy(e.currentTarget, true); const { error: er } = await sb.rpc('send_friend_request', { target: u.id }); if (er) { setBusy(e.currentTarget, false); return toast(errMsg(er), 'error'); } toast('Permintaan terkirim', 'success'); search(); });
    $('[data-acc]', res)?.addEventListener('click', async () => { const fr = (await fetchFriendships(me.id)).find((f) => f.other.id === u.id); if (fr) { await sb.rpc('respond_friend_request', { fid: fr.id, accept: true }); toast('Kalian sekarang berteman', 'success'); search(); } });
    $('[data-chat]', res)?.addEventListener('click', () => startChat(u.id, [m]));
  };
  $('#sf', m.el).onsubmit = (e) => { e.preventDefault(); search(); };
  if (/^\d{8}$/.test(prefill)) search();
}
$('#btnAdd').onclick = () => addFriendModal();

async function requestsModal() {
  const m = openModal({ title: 'Permintaan pertemanan', html: '<div id="rq" class="col"><p class="dim">Memuat…</p></div>' });
  const draw = async () => {
    const fr = (await fetchFriendships(me.id)).filter((f) => f.status === 'pending'), inc = fr.filter((f) => f.incoming), out = fr.filter((f) => !f.incoming);
    const row = (f, btns) => `<div class="row gap">${avatar(f.other.display_name, f.other.avatar_url, 42)}<span class="grow">${nameWithBadge(f.other.display_name, f.other.is_verified, 15, true, f.other.id)}<br><span class="dim">@${esc(f.other.username)}</span></span>${btns}</div>`;
    $('#rq', m.el).innerHTML = (!fr.length ? '<div class="empty" style="padding:24px"><p>Tidak ada permintaan.</p></div>' : '') + (inc.length ? '<p class="sec" style="margin:0">Masuk</p>' + inc.map((f) => row(f, `<button class="btn sm primary" data-ok="${f.id}">Terima</button><button class="btn sm ghost" data-no="${f.id}" aria-label="Tolak">${icon('x', 16)}</button>`)).join('') : '') + (out.length ? '<p class="sec" style="margin:8px 0 0">Terkirim</p>' + out.map((f) => row(f, `<button class="btn sm ghost" data-cancel="${f.id}">Batalkan</button>`)).join('') : '');
  };
  m.el.onclick = async (e) => {
    const b = e.target.closest('[data-ok],[data-no],[data-cancel]'); if (!b) return; setBusy(b, true);
    const { error } = b.dataset.ok ? await sb.rpc('respond_friend_request', { fid: b.dataset.ok, accept: true }) : b.dataset.no ? await sb.rpc('respond_friend_request', { fid: b.dataset.no, accept: false }) : await sb.rpc('remove_friendship', { fid: b.dataset.cancel });
    if (error) { setBusy(b, false); return toast(errMsg(error), 'error'); } await draw(); refreshReq();
  };
  draw().catch((e) => { $('#rq', m.el).innerHTML = `<p class="err">${esc(errMsg(e))}</p>`; });
}
$('#btnReq').onclick = requestsModal;

function openContact(u, m) {
  profileScreen({ name: u.display_name, username: u.username, orvixId: u.orvix_id, avatarUrl: u.avatar_url, bannerUrl: u.banner_url, verified: u.is_verified, userId: u.user_id, bio: u.status_text, seen: u.last_seen_at ? lastSeenText(u.last_seen_at) : '', actions: [
    { label: 'Chat', icon: 'chat', run: (close) => { close(); setTimeout(() => startChat(u.user_id, [m]), 200); } },
    { label: 'Laporkan', icon: 'flag', run: () => reportModal(u.user_id, u.display_name) },
    { label: 'Hapus pertemanan', icon: 'trash', tone: 'danger', run: async (close) => {
      if (!(await confirmDialog({ title: `Hapus ${u.display_name} dari teman?`, message: 'Riwayat chat tidak dihapus. Kamu bisa menambahkannya lagi nanti.', confirmText: 'Hapus', danger: true }))) return;
      const { error } = await sb.rpc('remove_friendship', { fid: u.friendship_id }); if (error) return toast(errMsg(error), 'error');
      toast('Pertemanan dihapus', 'success'); close(); m.el.querySelector(`[data-row="${u.user_id}"]`)?.remove(); } }] });
}
async function friendsModal() {
  const m = openModal({ title: 'Teman', wide: true, cls: 'contacts', html: `<div class="row gap" style="margin-bottom:10px"><div class="csearch grow">${icon('search', 18)}<input id="cq" type="search" placeholder="Cari nama atau ID ORVIX" aria-label="Cari kontak" autocomplete="off"></div><select class="inp" id="cs" aria-label="Urutkan" style="width:auto"><option value="name">Nama A–Z</option><option value="activity">Aktivitas terbaru</option></select></div><button class="btn block" id="newG" style="margin-bottom:10px">${icon('users')} Grup baru</button><div id="fl" class="col" style="gap:4px" aria-live="polite"></div><button class="btn block hide" id="more" style="margin-top:10px">Muat lebih banyak</button>` });
  const list = $('#fl', m.el), more = $('#more', m.el), SZ = 20; let off = 0, total = 0, gen = 0;
  const row = (c) => `<div class="row gap crow2" data-row="${c.user_id}">${avatar(c.display_name, c.avatar_url, 44)}<span class="grow" style="min-width:0">${nameWithBadge(c.display_name, c.is_verified, 15, true, c.user_id)}<br><span class="dim ell" style="display:block">@${esc(c.username)} · ID ${esc(c.orvix_id)}</span>${c.status_text ? `<span class="muted ell sm" style="display:block">${esc(c.status_text)}</span>` : ''}${c.last_seen_at ? `<span class="dim ${Date.now() - new Date(c.last_seen_at) < 120000 ? 'on-now' : ''}" style="font-size:12px">${esc(lastSeenText(c.last_seen_at))}</span>` : ''}</span><button class="btn sm primary" data-chat="${c.user_id}">${icon('chat', 16)} Chat</button><button class="ibtn" data-more="${c.user_id}" data-f="${c.friendship_id}" aria-label="Menu kontak ${esc(c.display_name)}">${icon('more', 18)}</button></div>`;
  const cache = new Map();
  async function load(reset) {
    const my = ++gen; if (reset) { off = 0; list.innerHTML = '<div class="skel-list" aria-hidden="true"><i></i><i></i><i></i></div>'; more.classList.add('hide'); } else setBusy(more, true);
    const { data, error } = await sb.rpc('orvix_list_contacts', { p_q: $('#cq', m.el).value, p_sort: $('#cs', m.el).value, p_limit: SZ, p_offset: off });
    if (my !== gen) return; if (!reset) setBusy(more, false);
    if (error) { if (reset) list.innerHTML = `<div class="empty"><h3>Gagal memuat teman</h3><p>${esc(errMsg(error))}</p><button class="btn" id="rtc" style="margin-top:12px">Coba lagi</button></div>`; else toast(errMsg(error), 'error'); $('#rtc', m.el) && ($('#rtc', m.el).onclick = () => load(true)); return; }
    data.forEach((c) => cache.set(c.user_id, c)); total = data[0]?.total ?? total; off += data.length;
    if (reset) list.innerHTML = '';
    if (reset && !data.length) list.innerHTML = `<div class="empty" style="padding:24px">${icon('users', 36)}<h3>${$('#cq', m.el).value.trim() ? 'Tidak ada hasil' : 'Belum ada teman'}</h3><p>${$('#cq', m.el).value.trim() ? 'Coba nama atau ID lain.' : 'Tambahkan teman dengan ID ORVIX-nya.'}</p></div>`;
    list.insertAdjacentHTML('beforeend', data.map(row).join('')); more.classList.toggle('hide', off >= total);
  }
  $('#cq', m.el).oninput = debounce(() => load(true), 350); $('#cs', m.el).onchange = () => load(true); more.onclick = () => load(false);
  $('#newG', m.el).onclick = async () => { try { const fr = (await fetchFriendships(me.id)).filter((f) => f.status === 'accepted'); m.close(); groupModal(fr); } catch (e) { toast(errMsg(e), 'error'); } };
  m.el.onclick = (e) => {
    const c = e.target.closest('[data-chat]'); if (c) return startChat(c.dataset.chat, [m]);
    const rw = e.target.closest('[data-row]'); if (rw && !e.target.closest('[data-more]')) { const u0 = cache.get(rw.dataset.row); if (u0) return openContact(u0, m); }
    const mo = e.target.closest('[data-more]'); if (!mo) return; const u = cache.get(mo.dataset.more); if (!u) return;
    const sh = openModal({ title: u.display_name, sheet: true, html: `<div class="col"><button class="btn" data-a="p">${icon('user')} Lihat profil</button><button class="btn danger" data-a="rm">${icon('trash')} Hapus pertemanan</button></div>` });
    sh.el.onclick = async (ev) => {
      const a = ev.target.closest('[data-a]')?.dataset.a; if (!a) return; sh.close();
      if (a === 'p') openContact(u, m);
      if (a === 'rm' && await confirmDialog({ title: `Hapus ${u.display_name} dari teman?`, message: 'Riwayat chat tidak dihapus. Kamu bisa menambahkannya lagi nanti.', confirmText: 'Hapus', danger: true })) {
        const { error } = await sb.rpc('remove_friendship', { fid: u.friendship_id }); if (error) return toast(errMsg(error), 'error');
        cache.delete(u.user_id); m.el.querySelector(`[data-row="${u.user_id}"]`)?.remove(); total = Math.max(0, total - 1); off = Math.max(0, off - 1); toast('Pertemanan dihapus', 'success');
        if (!list.querySelector('[data-row]')) load(true);
      }
    };
  };
  load(true);
}
$('#btnFriends').onclick = friendsModal;

/* ---------- Kontak: orang yang pernah dihubungi atau dicari ---------- */
async function contactsModal() {
  const m = openModal({ title: 'Kontak', wide: true, cls: 'contacts', html: `<div class="csearch" style="margin-bottom:10px">${icon('search', 18)}<input id="kq" type="search" placeholder="Cari nama atau ID ORVIX" aria-label="Cari kontak" autocomplete="off"></div><div class="tabs ktabs" role="tablist" style="padding:0 0 10px"><button class="tab" role="tab" data-k="chat" aria-selected="true">Pernah dihubungi</button><button class="tab" role="tab" data-k="search" aria-selected="false">Pernah dicari</button></div><div id="kl" class="col" style="gap:4px" aria-live="polite"></div>` });
  const list = $('#kl', m.el); let all = [], kind = 'chat';
  const row = (c) => `<div class="row gap crow2" data-row="${c.user_id}">${avatar(c.display_name, c.avatar_url, 44)}<span class="grow" style="min-width:0">${nameWithBadge(c.display_name, c.is_verified, 15, true, c.user_id)}<br><span class="dim ell" style="display:block">@${esc(c.username)} · ID ${esc(c.orvix_id)}</span><span class="dim" style="font-size:12px">${c.source === 'chat' ? 'Terakhir chat ' : 'Dicari '}${esc(relTime(c.last_at))}</span></span><button class="btn sm primary" data-go="${c.user_id}">${c.source === 'chat' ? icon('chat', 16) + ' Chat' : 'Buka'}</button><button class="ibtn" data-del="${c.user_id}" aria-label="Hapus ${esc(c.display_name)} dari kontak">${icon('trash', 18)}</button></div>`;
  const draw = () => {
    const rows = all.filter((c) => (kind === 'chat' ? c.source === 'chat' : c.source === 'search'));
    list.innerHTML = rows.length ? rows.map(row).join('') : `<div class="empty" style="padding:24px">${icon(kind === 'chat' ? 'chat' : 'search', 36)}<h3>${kind === 'chat' ? 'Belum ada kontak chat' : 'Belum ada pencarian'}</h3><p>${kind === 'chat' ? 'Orang yang pernah kamu ajak chat tersimpan di sini.' : 'ID ORVIX yang pernah kamu cari tersimpan di sini.'}</p></div>`;
  };
  const load = async () => {
    const { data, error } = await sb.rpc('orvix_saved_contacts_list', { p_q: $('#kq', m.el).value });
    if (error) { list.innerHTML = `<p class="err">${esc(dbErr(error, '13c-kontak.sql'))}</p>`; return; } all = data || []; draw();
  };
  $$('.ktabs .tab', m.el).forEach((b) => b.onclick = () => { kind = b.dataset.k; $$('.ktabs .tab', m.el).forEach((x) => x.setAttribute('aria-selected', x === b)); draw(); });
  $('#kq', m.el).oninput = debounce(load, 300);
  m.el.onclick = async (e) => {
    const go = e.target.closest('[data-go]'), del = e.target.closest('[data-del]');
    if (go) { const c = all.find((x) => x.user_id === go.dataset.go); if (!c) return; if (c.source === 'chat') return startChat(c.user_id, [m]); m.close(); return addFriendModal(c.orvix_id); }
    if (del) {
      const c = all.find((x) => x.user_id === del.dataset.del); if (!c) return;
      if (!(await confirmDialog({ title: `Hapus ${c.display_name} dari kontak?`, message: 'Hanya menghapus dari daftar kontak. Chat dan pertemananmu tidak berubah.', confirmText: 'Hapus', danger: true }))) return;
      const { error } = await sb.rpc('orvix_remove_saved_contact', { target: c.user_id }); if (error) return toast(dbErr(error, '13c-kontak.sql'), 'error');
      all = all.filter((x) => x.user_id !== c.user_id); draw(); toast('Dihapus dari kontak', 'success');
    }
  };
  load();
}

function groupModal(fr) {
  if (!fr.length) return toast('Tambahkan teman terlebih dahulu', 'error');
  const m = openModal({ title: 'Grup baru', html: `<div class="field"><label for="gt">Nama grup</label><input class="inp" id="gt" maxlength="60"></div><p class="sec" style="margin:0 0 6px">Pilih anggota</p><div class="col" style="gap:4px;max-height:240px;overflow:auto;margin-bottom:14px">${fr.map((f) => `<label class="row gap" style="padding:6px 2px"><input type="checkbox" value="${f.other.id}" style="width:20px;height:20px;accent-color:#1769FF">${avatar(f.other.display_name, f.other.avatar_url, 34)}<span class="ell">${esc(f.other.display_name)}</span></label>`).join('')}</div><p class="err" id="ge"></p><button class="btn primary block" id="gc">Buat grup</button>` });
  $('#gc', m.el).onclick = async (e) => {
    const title = $('#gt', m.el).value.trim(), ids = $$('input[type=checkbox]:checked', m.el).map((x) => x.value), er = $('#ge', m.el);
    if (!title) return (er.textContent = 'Isi nama grup.'); if (!ids.length) return (er.textContent = 'Pilih minimal 1 anggota.');
    setBusy(e.currentTarget, true, 'Membuat…'); const { data, error } = await sb.rpc('create_group', { title, member_ids: ids });
    if (error) { setBusy(e.currentTarget, false); return (er.textContent = errMsg(error)); }
    m.close(); await loadConvs(); openConv(data);
  };
}
$('#fab').onclick = () => {
  const m = openModal({ title: 'Mulai', sheet: true, html: `<div class="col"><button class="btn" data-a="add">${icon('userplus')} Tambah teman dengan ID</button><button class="btn" data-a="contacts">${icon('contacts')} Kontak</button><button class="btn" data-a="friends">${icon('users')} Pilih dari teman / grup baru</button><button class="btn" data-a="gsearch">${icon('search')} Cari pesan</button><button class="btn" data-a="glist">${icon('clock')} Pesan terjadwal ${isPremium(me) ? '' : '<span class="pill prem" style="margin-left:auto">Premium</span>'}</button></div>` });
  m.el.onclick = (e) => { const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return; m.close(); a === 'add' ? addFriendModal() : a === 'contacts' ? contactsModal() : a === 'gsearch' ? searchHere(true) : a === 'glist' ? openScheduledList({ me, titleOf }) : friendsModal(); };
};

closeConv(); layout.classList.remove('open');
await Promise.all([loadConvs(), loadBlocked().catch(() => {})]); refreshReq();
(async () => {   // pemberitahuan dari moderator/verifikasi (sekali tampil)
  const { data } = await sb.from('user_notices').select('id,kind,title,body,created_at').is('read_at', null).order('created_at', { ascending: false }).limit(5);
  if (!data?.length) return;
  const m = openModal({ title: 'Pemberitahuan', html: data.map((n) => `<div class="card" style="margin-bottom:10px"><b>${icon(n.kind === 'warning' ? 'flag' : 'badge', 16)} ${esc(n.title)}</b><p class="muted" style="margin-top:6px">${esc(n.body)}</p><p class="dim" style="margin-top:4px">${relTime(n.created_at)}</p></div>`).join('') + '<button class="btn primary block" data-ok>Mengerti</button>', onClose: () => sb.rpc('orvix_ack_notices').then(() => {}, () => {}) });
  m.el.querySelector('[data-ok]').onclick = m.close;
})().catch(() => {});
if (new URLSearchParams(location.search).get('req') === '1') setTimeout(() => requestsModal(), 400);   // dari notifikasi permintaan pertemanan
const deep = new URLSearchParams(location.search).get('c'); if (deep && convs.some((c) => c.conv_id === deep)) openConv(deep, false);
