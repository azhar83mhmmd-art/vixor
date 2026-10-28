// Dashboard chat: daftar percakapan, chat pribadi/grup, teman, Realtime.
import { sb, requireAuth, track, untrack, fetchProfiles, fetchFriendships, errMsg, cacheMe } from './supabase.js';
import { openPremiumHub } from './premium.js';
import { sendMessage, removeMedia, mediaHTML, hydrate, lightbox, isPlaceholder, ACCEPT, fmtDur } from './media.js';
import { pushActiveLocal } from './push.js';
import { Recorder, voiceSupported, bindPlayer, syncVoice, stopVoice } from './voice.js';
import { ensureUnlocked, isUnlocked, unlockSession, onRelock, lockSession, hasPin, emojiPicker, QUICK, forwardPicker, mutePicker, isMuted, starredModal } from './chatx.js';
import { shareInvite } from './share.js';
import { draftBind, draftClear, openScheduleModal, openScheduledList, openSearch, premiumInfo } from './advmsg.js';
import { startCall, joinCall, activeSession, openCalls, bus as callBus } from './calls-core.js';
import { $, $$, esc, icon, avatar, nameWithBadge, verifiedBadge, fmtTime, fmtDay, listTime, relTime, toast, setBusy, openModal, confirmDialog, copyText, debounce, mountShell, profileScreen, isPremium } from './utils.js';

const { profile: me } = await requireAuth({ shell: '/chat' });
mountShell('/chat', me.role === 'admin');
const CK = 'orvix:convs:' + me.id;
const saveConvs = (d) => { try { sessionStorage.setItem(CK, JSON.stringify(d.map((c) => (c.locked ? { ...c, last_content: '' } : c)))); } catch { /* abaikan */ } };

const PAGE = 40, DEL_MS = 60 * 60 * 1000;
const editMs = () => (isPremium(me) ? 60 : 15) * 60 * 1000;   // Premium: edit pesan hingga 1 jam
let sel = new Set(), selMode = false, blocked = new Set(), lpFired = false;
let msel = new Set(), mlpT, mlpFired = false, selPushed = false, skipPop = false;   // pilihan pesan (tekan lama) di dalam percakapan
let convs = [], tab = 'all', q = '', activeId = null, msgs = [], hasMore = false, seq = 0;
let view = 'main', replyTo = null, reacts = new Map(), starred = new Set(), replyCache = new Map(), typingCh = null, typingT = 0, typers = new Map(), rec = null, recT = 0, newBelow = 0;   // tampilan daftar (main/archived/locked), balasan, reaksi, bintang, mengetik, perekam suara
let reads = new Map(), members = [], disSecs = null, stInfo = new Map(), sUrls = new Map();   // status pesan, anggota, pesan sementara, referensi story
const prof = new Map();            // cache profil
const layout = $('#layout'), thread = $('#thread'), listEl = $('#convList');

$('#btnReq').innerHTML = icon('bell') + '<span class="badge-n hide" id="reqN"></span>';
$('#btnPrem').innerHTML = icon('crown'); $('#btnFriends').innerHTML = icon('users'); $('#btnAdd').innerHTML = icon('userplus'); $('#fab').innerHTML = icon('plus', 24);
$('.searchbar').innerHTML = `${icon('search')}<input class="inp" id="q" type="search" placeholder="Cari chat atau ID ORVIX" aria-label="Cari chat atau ID ORVIX" autocomplete="off">`;
$('.pane-head').insertAdjacentHTML('afterend', `<header class="pane-head sel-head hide" id="selHead"><button class="ibtn" id="selX" aria-label="Batal memilih">${icon('x')}</button><h1 id="selN">0</h1><button class="ibtn" id="selPin" aria-label="Sematkan chat">${icon('pin')}</button><button class="ibtn" id="selArch" aria-label="Arsipkan chat">${icon('archive')}</button><button class="ibtn" id="selDel" aria-label="Hapus chat">${icon('trash')}</button><button class="ibtn" id="selMore" aria-label="Lainnya">${icon('more')}</button></header>`);
listEl.insertAdjacentHTML('beforebegin', '<div id="conn" class="alert warn hide" style="margin:0 14px 8px">Menghubungkan ulang…</div>');

let lastSeenTxt = '';
const lastSeenText = (t) => (Date.now() - new Date(t) < 120000 ? 'Online' : 'Terakhir aktif ' + relTime(t));
const paintSub = () => {
  const el = $('#hSub'); if (!el) return; const c = curConv() || {}, now = Date.now();
  const act = [...typers].filter(([, t]) => t > now).map(([u]) => u), grp = c.conv_type === 'group';
  const tp = act.length ? (grp ? act.map((u) => (prof.get(u)?.display_name || 'Seseorang').split(' ')[0]).join(', ') + ' sedang mengetik…' : 'sedang mengetik…') : '';
  el.classList.toggle('typing', !!tp);
  el.textContent = tp || [grp ? 'Grup' : lastSeenTxt, disSecs ? 'Pesan sementara ' + DIS[disSecs] : '', isMuted(c) ? 'Dibisukan' : ''].filter(Boolean).join(' · ');
};
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

const isUnr = (c) => c.unread > 0 || c.marked_unread;
const inView = (c) => (view === 'archived' ? c.archived && !c.locked : view === 'locked' ? c.locked : !c.archived && !c.locked);
const VIEW_T = { archived: 'Diarsipkan', locked: 'Chat terkunci' };
function renderList() {
  const s = q.trim().toLowerCase(), arch = convs.filter((c) => c.archived && !c.locked), lck = convs.filter((c) => c.locked);
  let rows = convs.filter((c) => inView(c) && (tab === 'all' || (tab === 'unread' ? isUnr(c) : c.conv_type === tab)) && (!s || convName(c).toLowerCase().includes(s) || (c.other_username || '').includes(s) || (view !== 'locked' && (c.last_content || '').toLowerCase().includes(s))));
  let html = view !== 'main' ? `<div class="lv-h"><button class="ibtn" data-lvback aria-label="Kembali">${icon('back')}</button><span class="grow"><b>${VIEW_T[view]}</b><small class="dim" style="display:block">${view === 'archived' ? 'Chat diarsipkan muncul lagi di daftar saat ada pesan baru.' : 'Disembunyikan dari daftar utama dan notifikasinya tanpa isi pesan.'}</small></span></div>` : '';
  if (view === 'main' && !s && tab === 'all') {
    if (arch.length) html += `<button class="item folder" data-folder="archived"><span class="av folder-av">${icon('archive', 22)}</span><span class="grow"><span class="t"><span>Diarsipkan</span><span class="when">${arch.length}</span></span></span></button>`;
    if (lck.length || hasPin(me.id)) html += `<button class="item folder" data-folder="locked"><span class="av folder-av">${icon('lock', 22)}</span><span class="grow"><span class="t"><span>Chat terkunci</span><span class="when">${lck.length || ''}</span></span></span></button>`;
  }
  html += /^\d{8}$/.test(s) ? `<button class="item" data-id-search="${esc(s)}"><span class="av" style="width:46px;height:46px">${icon('search')}</span><span class="grow"><span class="t">Cari ID ORVIX ${esc(s)}</span><span class="p">Ketuk untuk mencari teman</span></span></button>` : '';
  if (!rows.length && !/^\d{8}$/.test(s)) {
    html += view !== 'main' ? `<div class="empty">${icon(view === 'archived' ? 'archive' : 'lock', 40)}<h3>${view === 'archived' ? 'Tidak ada chat diarsipkan' : 'Belum ada chat terkunci'}</h3><p>${view === 'archived' ? 'Pilih chat (tekan lama), lalu ketuk ikon arsip.' : 'Buka menu chat, lalu pilih Kunci chat.'}</p></div>`
      : convs.filter(inView).length ? `<div class="empty"><h3>Tidak ada hasil</h3><p>${tab === 'unread' ? 'Semua chat sudah dibaca.' : 'Coba kata kunci lain.'}</p></div>` : `<div class="empty">${icon('chat', 40)}<h3>Belum ada percakapan</h3><p>Tambahkan teman dengan ID ORVIX-nya, lalu mulai chat.</p><button class="btn primary" id="emptyAdd" style="margin-top:14px">Tambah teman</button></div>`;
  }
  html += rows.map((c) => {
    const nm = convName(c), av = c.conv_type === 'group' ? `<span class="av" style="width:48px;height:48px">${icon('users')}</span>` : avatar(nm, c.other_avatar, 48), muted = isMuted(c);
    const badge = c.unread > 0 ? `<span class="unread${muted ? ' muted' : ''}" aria-label="${c.unread} belum dibaca">${c.unread > 99 ? '99+' : c.unread}</span>` : c.marked_unread ? '<span class="unread dot" aria-label="Ditandai belum dibaca"></span>' : '';
    return `<button class="item ${c.conv_id === activeId ? 'on' : ''}${sel.has(c.conv_id) ? ' sel' : ''}" data-c="${c.conv_id}" aria-pressed="${sel.has(c.conv_id)}">${av}<span class="grow"><span class="t"><span class="ell">${nameWithBadge(nm, c.other_verified, 15, false, c.conv_type === 'group' ? null : c.other_id)}</span><span class="when${isUnr(c) && !muted ? ' hot' : ''}">${listTime(c.last_at || c.created_at)}</span></span><span class="row between gap"><span class="p ell ${c.last_deleted ? 'gone-p' : ''}">${c.last_deleted ? icon('ban', 13) + ' ' : ''}${esc(previewOf(c))}</span>${muted ? `<span class="pinned" aria-label="Dibisukan">${icon('mutebell', 15)}</span>` : ''}${c.pinned ? `<span class="pinned" aria-label="Disematkan">${icon('pin', 15)}</span>` : ''}${badge}</span></span></button>`;
  }).join('');
  listEl.innerHTML = html;
  $('#emptyAdd') && ($('#emptyAdd').onclick = addFriendModal);
}
async function setView(v) {
  if (v === 'locked' && !(await ensureUnlocked(me, 'Masukkan PIN untuk membuka chat terkunci.'))) return;
  view = v; sel.clear(); paintSel(); listEl.scrollTop = 0;
}
onRelock(() => { if (view === 'locked') view = 'main'; const c = curConv(); if (c && c.locked) { if (history.state?.c) history.back(); else closeConv(); } renderList(); toast('Chat terkunci dikunci kembali'); });
listEl.onclick = (e) => {
  if (lpFired) { lpFired = false; return; }
  const it = e.target.closest('[data-c]'); if (it && selMode) return toggleSel(it.dataset.c);
  const fo = e.target.closest('[data-folder]'); if (fo) return fo.dataset.folder === 'locked' && !hasPin(me.id) ? lockIntro() : setView(fo.dataset.folder);
  if (e.target.closest('[data-lvback]')) return setView('main');
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
  $('#selPin').classList.toggle('on', rows.length > 0 && rows.every((c) => c.pinned));
  $('#selPin').classList.toggle('hide', view !== 'main');
  $('#selArch').setAttribute('aria-label', view === 'archived' ? 'Keluarkan dari arsip' : 'Arsipkan chat'); $('#selArch').classList.toggle('hide', view === 'locked');
  renderList();
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
const selRowsC = () => convs.filter((c) => sel.has(c.conv_id));
const prefCall = async (fn, args, ok) => { const { error } = await sb.rpc(fn, args); if (error) { toast(dbErr(error, '17a-fitur-chat.sql'), 'error'); return false; } if (ok) toast(ok, 'success'); await loadConvs(); return true; };
const leaveActiveIf = (ids) => { if (ids.includes(activeId)) { if (history.state?.c) history.back(); else closeConv(); } };
$('#selArch').onclick = async () => {
  const ids = [...sel], on = view !== 'archived'; if (!ids.length) return;
  if (await prefCall('orvix_archive_conversations', { convs: ids, p_on: on }, on ? (ids.length > 1 ? `${ids.length} chat diarsipkan` : 'Chat diarsipkan') : 'Dikeluarkan dari arsip')) { if (on) leaveActiveIf(ids); exitSel(); }
};
$('#selMore').onclick = () => {
  const rows = selRowsC(), allMuted = rows.length && rows.every(isMuted), allUnr = rows.length && rows.every((c) => c.marked_unread || c.unread > 0), allLocked = rows.length && rows.every((c) => c.locked);
  const m = openModal({ title: `${rows.length} chat dipilih`, sheet: true, html: `<div class="col"><button class="btn" data-a="mute">${icon(allMuted ? 'bell' : 'mutebell')} ${allMuted ? 'Bunyikan notifikasi' : 'Bisukan notifikasi'}</button><button class="btn" data-a="lock">${icon(allLocked ? 'unlock' : 'lock')} ${allLocked ? 'Buka kunci chat' : 'Kunci chat'}</button><button class="btn" data-a="unread">${icon('unread')} ${allUnr ? 'Tandai sudah dibaca' : 'Tandai belum dibaca'}</button><button class="btn" data-a="all">${icon('selall')} Pilih semua</button></div>` });
  m.el.onclick = async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return; m.close(); const ids = [...sel];
    if (a === 'all') { const vis = [...listEl.querySelectorAll('[data-c]')].map((x) => x.dataset.c); vis.every((i) => sel.has(i)) ? vis.forEach((i) => sel.delete(i)) : vis.forEach((i) => sel.add(i)); return paintSel(); }
    if (a === 'mute') { const u = await mutePicker(allMuted); if (u === undefined) return; if (await prefCall('orvix_mute_conversations', { convs: ids, p_until: u }, u ? 'Notifikasi dibisukan' : 'Notifikasi dibunyikan')) exitSel(); }
    if (a === 'unread') { if (await prefCall('orvix_mark_unread', { convs: ids, flag: !allUnr }, allUnr ? 'Ditandai sudah dibaca' : 'Ditandai belum dibaca')) exitSel(); }
    if (a === 'lock') { if (!(await ensureUnlocked(me))) return; if (await prefCall('orvix_lock_conversations', { convs: ids, p_on: !allLocked }, allLocked ? 'Kunci dibuka' : 'Chat dikunci')) { if (!allLocked) leaveActiveIf(ids); exitSel(); } }
  };
};
async function lockIntro() { if (await ensureUnlocked(me)) toast('PIN dibuat. Buka menu chat, lalu pilih Kunci chat.', 'success'); renderList(); }
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
  openScheduleModal({ me, convId: c.conv_id, convTitle: convName(c), text, onDone: () => { const ci = $('#ci'); if (ci && text && ci.value.trim() === text) { ci.value = ''; ci.style.height = 'auto'; draftClear(me, c.conv_id); ci.dispatchEvent(new Event('input')); } } });
}
function searchHere(all) {
  const c = all ? null : curConv(), senders = c && c.conv_type === 'group' ? members.filter((u) => u !== me.id).map((u) => ({ id: u, name: prof.get(u)?.display_name || 'Anggota' })) : c && c.other_id ? [{ id: c.other_id, name: c.other_name || 'Lawan chat' }] : [];
  openSearch({ me, convId: c ? c.conv_id : null, convTitle: c ? convName(c) : '', titleOf, senders, onOpen: (id) => { if (id !== activeId) openConv(id); } });
}

async function openConv(id, push = true) {
  const c0 = convs.find((x) => x.conv_id === id);
  if (c0?.locked && !(isUnlocked() ? true : await ensureUnlocked(me, 'Masukkan PIN untuk membuka chat ini.'))) return;
  if (c0?.locked) unlockSession(); if (c0?.marked_unread) { c0.marked_unread = false; sb.rpc('orvix_mark_unread', { convs: [id], flag: false }).then(() => {}, () => {}); }
  cancelRec(); stopVoice(); closeTyping(); replyTo = null; reacts = new Map(); starred = new Set(); newBelow = 0;
  msel.clear(); selPushed = false; thread.classList.remove('msel');
  activeId = id; msgs = []; hasMore = false; reads = new Map(); members = []; disSecs = null; layout.classList.add('open'); document.body.classList.add('in-conv');
  if (push) history.pushState({ c: id }, '');
  const c = curConv() || {}, grp = c.conv_type === 'group', nm = convName(c);
  lastSeenTxt = '';
  thread.innerHTML = `<header class="thead"><button class="ibtn back" aria-label="Kembali ke daftar chat">${icon('back')}</button><button class="row gap grow" id="hProfile" style="text-align:left;min-width:0">${grp ? `<span class="av" style="width:42px;height:42px">${icon('users')}</span>` : avatar(nm, c.other_avatar, 42)}<span class="grow"><span class="ell" style="display:block;font-weight:600">${nameWithBadge(nm, c.other_verified, 16, true, c.conv_type === 'group' ? null : c.other_id)}</span><span class="sub ell" id="hSub" style="display:block">${grp ? 'Grup' : ''}</span></span></button><button class="ibtn" id="hVoice" aria-label="${grp ? 'Panggilan suara grup' : 'Panggilan suara'}">${icon('phone')}</button><button class="ibtn" id="hVideo" aria-label="${grp ? 'Panggilan video grup' : 'Panggilan video'}">${icon('video')}</button><button class="ibtn" id="hMenu" aria-label="Menu percakapan">${icon('more')}</button></header><header class="msel-head hide" id="mselHead"><button class="ibtn" id="mselX" aria-label="Batal memilih pesan">${icon('x')}</button><h1 id="mselN" aria-live="polite">0 dipilih</h1><button class="ibtn hide" id="mselReply" aria-label="Balas pesan">${icon('reply')}</button><button class="ibtn" id="mselStar" aria-label="Bintangi pesan">${icon('star')}</button><button class="ibtn" id="mselFwd" aria-label="Teruskan pesan">${icon('forward')}</button><button class="ibtn" id="mselCopy" aria-label="Salin pesan">${icon('copy')}</button><button class="ibtn hide" id="mselEdit" aria-label="Edit pesan">${icon('edit')}</button><button class="ibtn hide" id="mselRep" aria-label="Laporkan pesan">${icon('flag')}</button><button class="ibtn danger" id="mselDel" aria-label="Hapus pesan">${icon('trash')}</button></header><div class="cl-banner" id="callBanner" hidden></div><div class="msgs" id="msgs" role="log" aria-live="polite" tabindex="0"><div class="empty">Memuat pesan…</div></div><button class="tobottom hide" id="toBottom" aria-label="Ke pesan terbaru">${icon('arrowdown', 20)}<span class="tb-n hide" id="tbN"></span></button><div class="replybar hide" id="replyBar"></div><form class="composer" id="cf"><button type="button" class="ibtn" id="emoBtn" aria-label="Emoji">${icon('smile')}</button><button type="button" class="ibtn" id="attach" aria-label="Kirim foto atau video">${icon('clip')}</button><input type="file" id="mf" accept="${ACCEPT}" hidden><textarea class="inp" id="ci" rows="1" maxlength="4000" placeholder="Tulis pesan" aria-label="Tulis pesan"></textarea>${isPremium(me) ? `<button type="button" class="ibtn" id="schedBtn" aria-label="Jadwalkan pesan">${icon('clock')}</button>` : ''}<button type="button" class="send mic" id="micBtn" aria-label="Rekam pesan suara">${icon('mic', 22)}</button><button class="send hide" id="sendBtn" aria-label="Kirim pesan" disabled>${icon('send')}</button><div class="recbar" id="recBar"><button type="button" class="ibtn danger" id="recCancel" aria-label="Batalkan rekaman">${icon('trash')}</button><span class="rec-dot" aria-hidden="true"></span><span class="rec-t" id="recT" aria-live="off">0:00</span><span class="rec-lv" id="recLv" aria-hidden="true"></span><button type="button" class="ibtn" id="recPause" aria-label="Jeda rekaman">${icon('pause')}</button><button type="button" class="send" id="recSend" aria-label="Kirim pesan suara">${icon('send')}</button></div></form><div class="blockbar hide" id="blk" role="status"></div>`;
  $('.back', thread).onclick = () => history.state?.c ? history.back() : closeConv();
  $('#hVoice').onclick = () => callFromChat('voice'); $('#hVideo').onclick = () => callFromChat('video'); paintCallBanner(); $('#attach').onclick = () => $('#mf').click(); $('#mf').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) sendMedia(f); };
  $('#hMenu').onclick = convMenu; $('#hProfile').onclick = showInfo;
  const ci = $('#ci'), sendBtn = $('#sendBtn');
  const micBtn = $('#micBtn'), voiceOK = voiceSupported();
  const syncSend = () => { const has = !!ci.value.trim(); sendBtn.disabled = !has; sendBtn.classList.toggle('hide', !has && voiceOK); micBtn.classList.toggle('hide', has || !voiceOK); };
  ci.oninput = () => { ci.style.height = 'auto'; ci.style.height = Math.min(ci.scrollHeight, 140) + 'px'; syncSend(); if (ci.value.trim()) sendTyping(); };
  syncSend(); bindComposerX(ci, syncSend);
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
  $('#msgs').addEventListener('scroll', () => { markRead(); paintToBottom(); }, { passive: true });
  bindMsgSelect($('#msgs')); bindPlayer($('#msgs')); bindSwipeReply($('#msgs')); $('#toBottom').onclick = () => { const el = $('#msgs'); el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); newBelow = 0; paintToBottom(); };
  $('#mselReply').onclick = () => { const m = selRows()[0]; if (m) { exitMsel(); startReply(m); } };
  $('#mselFwd').onclick = () => { const r = selRows(); if (r.length) { exitMsel(); forwardMsgs(r); } };
  $('#mselStar').onclick = () => { const r = selRows(), on = !r.every((m) => starred.has(m.id)); exitMsel(); starMsgs(r, on); };
  $('#mselX').onclick = () => exitMsel(); $('#mselCopy').onclick = copySelected; $('#mselDel').onclick = delSelected;
  $('#mselEdit').onclick = () => { const m = selRows()[0]; if (m && canEditMsg(m)) { exitMsel(); editMsg(m); } };
  $('#mselRep').onclick = () => { const m = selRows()[0]; if (m && m.sender_id !== me.id) { exitMsel(); reportModal(m.sender_id, prof.get(m.sender_id)?.display_name, m.id); } };
  renderList();
  try {
    const [{ data: mem }, { data: cv }] = await Promise.all([sb.from('conversation_members').select('user_id').eq('conversation_id', id), sb.from('conversations').select('disappear_secs').eq('id', id).maybeSingle()]);
    members = (mem || []).map((m) => m.user_id); disSecs = cv?.disappear_secs || null; paintSub();
    await ensureProfiles(members);
    await Promise.all([loadMsgs(id), loadReads(id)]);
    loadStoryRefs(); loadExtras(id); subscribeTyping(id);
  } catch (e) { if (activeId === id) $('#msgs').innerHTML = `<div class="empty"><h3>Gagal memuat pesan</h3><p>${esc(errMsg(e))}</p><button class="btn" id="rt2" style="margin-top:12px">Coba lagi</button></div>`; $('#rt2') && ($('#rt2').onclick = () => openConv(id, false)); return; }
  paintBlock(); markRead(); if (!blocked.has(c.other_id)) setTimeout(() => ci.focus({ preventScroll: true }), 50);
  if (!grp && c.other_id) sb.rpc('get_last_seen', { target: c.other_id }).then(({ data }) => {
    if (activeId !== id || !$('#hSub')) return;
    lastSeenTxt = data ? lastSeenText(data) : ''; paintSub();
  });
}

function closeConv() {
  unbindDraft(); unbindDraft = () => {}; cancelRec(); stopVoice(); closeTyping(); replyTo = null; reacts = new Map();
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
    const rx = reacts.get(m.id), rxHTML = rx && rx.size ? `<span class="rxs">${[...[...rx.values()].reduce((a, e) => a.set(e, (a.get(e) || 0) + 1), new Map())].map(([e, n]) => `<button type="button" class="rx${rx.get(me.id) === e ? ' mine' : ''}" data-rx="${esc(e)}" data-rm="${m.id}" aria-label="Reaksi ${esc(e)} ${n}">${esc(e)}${n > 1 ? `<i>${n}</i>` : ''}</button>`).join('')}</span>` : '';
    html += `<div class="msg ${mine ? 'out' : 'in'} ${m._st || ''}${picked ? ' sel' : ''}${m.media_type === 'audio' ? ' vn-msg' : ''}${rxHTML ? ' has-rx' : ''}" data-m="${m.id}"${msel.size ? ` role="checkbox" aria-checked="${picked}"` : ''}>${who}${m.forwarded ? `<span class="fwd-l">${icon('forward', 12)} Diteruskan</span>` : ''}${replyQuote(m)}${quoteHTML(m)}${mediaHTML(m)}${isPlaceholder(m) ? '' : esc(m.content)}<span class="meta">${starred.has(m.id) ? `<span class="m-star">${icon('star', 11)}</span>` : ''}${m.expires_at ? icon('timer', 12) + ' ' : ''}${fmtTime(m.created_at)}${m.edited_at ? ' · diedit' : ''}${mine ? tickHTML(m) : ''}${m._st === 'failed' ? ' · gagal' : ''}${m._st === 'failed' ? ` <button class="btn sm" data-retry="${m.id}" style="min-height:26px;padding:0 10px">Coba lagi</button>` : ''}</span>${rxHTML}</div>`;
  });
  el.innerHTML = html; syncVoice(el); hydrate(el).then(() => { syncVoice(el); if (mode === 'bottom' || near) el.scrollTop = el.scrollHeight; }); paintToBottom();
  if (mode === 'bottom' || (mode === 'auto' && near)) el.scrollTop = el.scrollHeight; else if (mode === 'keep') el.scrollTop = el.scrollHeight - prevH;
}

async function onMsgClick(e) {
  if (e.target.closest('[data-older]')) { const b = e.target.closest('[data-older]'); setBusy(b, true); try { await loadMsgs(activeId, true); loadExtras(activeId); } catch (x) { toast(errMsg(x), 'error'); setBusy(b, false); } return; }
  const rt = e.target.closest('[data-retry]'); if (rt) { const m = msgs.find((x) => x.id === rt.dataset.retry); if (m) { m._st = 'sending'; render(); insertMsg(m); } return; }
  const sb2 = e.target.closest('[data-story]'); if (sb2) { location.href = '/updates?story=' + sb2.dataset.story; return; }
  const sn = e.target.closest('[data-seen]'); if (sn) { const mm = msgs.find((x) => x.id === sn.dataset.seen); if (mm) seenModal(mm); return; }
  const rq = e.target.closest('[data-rq]'); if (rq) return jumpTo(rq.dataset.rq);
  const rxb = e.target.closest('[data-rx]'); if (rxb) { const mm = msgs.find((x) => x.id === rxb.dataset.rm); if (mm) reactionsModal(mm); return; }
  const el = e.target.closest('[data-m]'); if (!el) return; const m = msgs.find((x) => x.id === el.dataset.m); if (!m || m._st) return;
  const mine = m.sender_id === me.id, age = Date.now() - new Date(m.created_at), canEdit = mine && !m.media_path && age < editMs(), canDel = mine && age < DEL_MS, grp = (curConv() || {}).conv_type === 'group';
  const my = reacts.get(m.id)?.get(me.id), st = starred.has(m.id);
  const sh = openModal({ title: 'Pesan', sheet: true, cls: 'msgmenu', html: `<div class="qr" role="group" aria-label="Beri reaksi">${QUICK.map((q) => `<button type="button" class="${my === q ? 'on' : ''}" data-q="${q}" aria-label="Reaksi ${q}">${q}</button>`).join('')}<button type="button" data-q="+" aria-label="Emoji lain">${icon('plus', 18)}</button></div><div class="col" style="gap:8px"><button class="btn" data-a="reply">${icon('reply')} Balas</button><button class="btn" data-a="fwd">${icon('forward')} Teruskan</button>${m.media_path ? '' : `<button class="btn" data-a="copy">${icon('copy')} Salin</button>`}<button class="btn" data-a="star">${icon('star')} ${st ? 'Lepas bintang' : 'Bintangi'}</button>${mine && grp ? `<button class="btn" data-a="info">${icon('eye')} Info pesan</button>` : ''}${canEdit ? `<button class="btn" data-a="edit">${icon('edit')} Edit (maks. ${isPremium(me) ? '1 jam' : '15 menit'})</button>` : ''}${mine ? (canDel ? `<button class="btn danger" data-a="del">${icon('trash')} Hapus untuk semua</button>` : `<p class="hint" style="text-align:center">Hapus untuk semua hanya tersedia dalam 1 jam setelah pesan dikirim.</p>`) : `<button class="btn" data-a="rep">${icon('flag')} Laporkan pesan</button>`}</div>` });
  sh.el.onclick = async (ev) => {
    const q = ev.target.closest('[data-q]')?.dataset.q;
    if (q) { sh.close(); if (q === '+') { const pop = emojiPicker({ anchor: thread, onPick: (em) => { pop.remove(); react(m, em); } }); return; } return react(m, q); }
    const a = ev.target.closest('[data-a]')?.dataset.a; if (!a) return; sh.close();
    if (a === 'reply') startReply(m);
    if (a === 'fwd') forwardMsgs([m]);
    if (a === 'star') starMsgs([m], !st);
    if (a === 'info') seenModal(m);
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
  $('#mselReply').classList.toggle('hide', !one);
  $('#mselStar').classList.toggle('on', rows.length > 0 && rows.every((m) => starred.has(m.id)));
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
  ci.value = ''; ci.style.height = 'auto'; ci.dispatchEvent(new Event('input')); draftClear(me, activeId);
  const tmp = { id: 'tmp-' + ++seq, conversation_id: activeId, sender_id: me.id, content: text, created_at: new Date().toISOString(), _st: 'sending', reply_to: replyTo ? replyTo.id : null };
  clearReply(); stopTypingNow(); msgs.push(tmp); render('bottom'); insertMsg(tmp);
}
async function insertMsg(tmp) {
  const row = { conversation_id: tmp.conversation_id, sender_id: me.id, content: tmp.content }; if (tmp.reply_to && !String(tmp.reply_to).startsWith('tmp-')) row.reply_to = tmp.reply_to;
  const { data, error } = await sb.from('messages').insert(row).select().single();
  if (tmp.conversation_id !== activeId) { if (!error) refreshList(); return; }
  if (error) { tmp._st = 'failed'; render('auto'); return toast(sendErr(error), 'error'); }
  const cc = curConv(); if (cc?.conv_type === 'direct' && cc.other_id && !savedOnce.has(cc.other_id)) { savedOnce.add(cc.other_id); saveContact(cc.other_id, 'chat'); }
  msgs = msgs.filter((m) => m !== tmp); if (!msgs.some((m) => m.id === data.id)) msgs.push(data);
  msgs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)); render('bottom'); refreshList();
}
async function sendMedia(file) {
  const id = activeId, rp = replyTo ? replyTo.id : null, tmp = { id: 'tmp-' + ++seq, conversation_id: id, sender_id: me.id, content: 'Mengunggah…', created_at: new Date().toISOString(), _st: 'sending', reply_to: rp };
  clearReply(); msgs.push(tmp); render('bottom');
  try {
    const row = await sendMessage({ conv: id, me: me.id, file, replyTo: rp, onProgress: (f) => { tmp.content = `Mengunggah ${Math.round(f * 100)}%`; const el = $(`[data-m="${tmp.id}"]`); if (el?.firstChild) el.firstChild.textContent = tmp.content; } });
    if (id !== activeId) return refreshList();
    msgs = msgs.filter((m) => m !== tmp); if (!msgs.some((m) => m.id === row.id)) msgs.push(row); msgs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)); render('bottom'); refreshList();
  } catch (e) { msgs = msgs.filter((m) => m !== tmp); render('auto'); toast(sendErr(e), 'error'); }
}
const savedOnce = new Set();
const sendErr = (e) => (/Format berkas tidak diizinkan|reply_to|duration_ms|\bwave\b|forwarded|media_type_check|message_type_check/i.test(errMsg(e)) ? 'Fitur ini belum aktif di database. Jalankan sql-parts/17a-fitur-chat.sql di SQL Editor Supabase, lalu muat ulang halaman.' : /row-level security|violates|permission denied/i.test(errMsg(e)) ? 'Pesan tidak terkirim. Kamu tidak bisa mengirim pesan ke percakapan ini.' : errMsg(e));
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
const notifTag = (id) => 'msg-' + String(id).replace(/[^0-9a-zA-Z-]/g, '').slice(0, 40);
// Notifikasi dalam-aplikasi (cadangan Web Push). Tag sama dengan notifikasi service worker, jadi keduanya saling menggantikan (tidak dobel).
function notify(convId, title, body) {
  const c = convs.find((x) => x.conv_id === convId); if (c && isMuted(c)) return;
  if (c && c.locked) { title = 'ORVIX'; body = 'Pesan baru'; }
  if (!document.hidden) { if (convId !== activeId) toast(`${title}: ${String(body || '').slice(0, 80)}`); return; }
  if ((localStorage.getItem('orvix_notif') === '1' || pushActiveLocal(me.id)) && 'Notification' in window && Notification.permission === 'granted') {
    try { const n = new Notification(title, { body: String(body || '').slice(0, 120), icon: '/assets/icon-192.png', badge: '/assets/badge-96.png', tag: notifTag(convId) }); n.onclick = () => { focus(); n.close(); openConv(convId); }; } catch { /* abaikan */ }
  }
}
async function onInsert({ new: m }) {
  if (m.sender_id !== me.id && m.message_type !== 'system') markDelivered(m.conversation_id);   // pesan sudah sampai di perangkat ini
  if (m.conversation_id === activeId) {
    const near = atBottom();
    if (!msgs.some((x) => x.id === m.id)) { await ensureProfiles([m.sender_id]); msgs.push(m); msgs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)); if (!near && m.sender_id !== me.id && m.message_type !== 'system') newBelow++; render('auto'); if (m.reply_to) loadReplyRefs(); }
    if (m.sender_id !== me.id) { typers.delete(m.sender_id); paintSub(); markRead(); if (m.story_id) loadStoryRefs(); if (document.hidden && m.message_type !== 'system') notify(m.conversation_id, convName(curConv() || {}), m.content); }
  } else if (m.sender_id !== me.id && m.message_type !== 'system') {
    const c = convs.find((x) => x.conv_id === m.conversation_id); if (c?.conv_type === 'channel') { refreshList(); return; } notify(m.conversation_id, c ? convName(c) : 'Pesan baru', m.content);
  }
  refreshList();
}
function onUpdate({ new: m }) { if (m.conversation_id === activeId) applyUpdate(m); refreshList(); }
function onReact({ eventType, new: n, old: o }) {
  const r = eventType === 'DELETE' ? o : n; if (!r || !r.message_id) return;
  if (!msgs.some((m) => m.id === r.message_id)) return;
  setRx(r.message_id, r.user_id, eventType === 'DELETE' ? null : r.emoji); render('auto');
}
track(sb.channel('rx-' + me.id).on('postgres_changes', { event: '*', schema: 'public', table: 'orvix_msg_reactions' }, onReact).subscribe());
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
  const m = openModal({ title: grp ? 'Grup' : 'Percakapan', sheet: true, html: `<div class="col"><button class="btn" data-a="info">${icon('user')} ${grp ? 'Anggota grup' : 'Lihat profil'}</button><button class="btn" data-a="dis">${icon('timer')} Pesan sementara <span class="dim" style="margin-left:auto">${DIS[disSecs || 0]}</span></button>${grp ? `<button class="btn" data-a="share">${icon('link')} Bagikan link grup</button><button class="btn danger" data-a="leave">${icon('logout')} Keluar grup</button>` : `<button class="btn" data-a="report">${icon('flag')} Laporkan</button>${blocked.has(c.other_id) ? `<button class="btn" data-a="unblock">${icon('unlock')} Buka blokir</button>` : `<button class="btn danger" data-a="block">${icon('ban')} Blokir</button>`}`}<button class="btn" data-a="mute">${icon(isMuted(c) ? 'bell' : 'mutebell')} ${isMuted(c) ? 'Bunyikan notifikasi' : 'Bisukan notifikasi'}</button><button class="btn" data-a="lock">${icon(c.locked ? 'unlock' : 'lock')} ${c.locked ? 'Buka kunci chat' : 'Kunci chat'}</button><button class="btn" data-a="arch">${icon('archive')} ${c.archived ? 'Keluarkan dari arsip' : 'Arsipkan chat'}</button><button class="btn" data-a="unread">${icon('unread')} Tandai belum dibaca</button><button class="btn" data-a="stars">${icon('star')} Pesan berbintang</button><button class="btn" data-a="search">${icon('search')} Cari pesan</button><button class="btn" data-a="sched">${icon('clock')} ${isPremium(me) ? 'Jadwalkan pesan' : 'Pesan terjadwal'} ${isPremium(me) ? '' : '<span class="pill prem" style="margin-left:auto">Premium</span>'}</button><button class="btn" data-a="export">${icon('download')} Ekspor chat ${isPremium(me) ? '' : '<span class="pill prem" style="margin-left:auto">Premium</span>'}</button></div>` });
  m.el.onclick = async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return; m.close();
    if (a === 'info') showInfo();
    if (a === 'dis') disappearModal();
    if (a === 'share') shareInvite(c.conv_id, c.title || 'Grup', 'grup');
    if (a === 'report') reportModal(c.other_id, c.other_name);
    if (a === 'block') blockCurrent(c);
    if (a === 'unblock') unblockCurrent(c);
    if (a === 'search') searchHere(false);
    if (a === 'stars') openStarred();
    if (a === 'mute') { const u = await mutePicker(isMuted(c)); if (u !== undefined && await prefCall('orvix_mute_conversations', { convs: [c.conv_id], p_until: u }, u ? 'Notifikasi dibisukan' : 'Notifikasi dibunyikan')) paintSub(); }
    if (a === 'lock') { if (!(await ensureUnlocked(me))) return; const on = !c.locked; if (await prefCall('orvix_lock_conversations', { convs: [c.conv_id], p_on: on }, on ? 'Chat dikunci. Buka lewat folder Chat terkunci.' : 'Kunci dibuka') && on) { if (history.state?.c) history.back(); else closeConv(); } }
    if (a === 'arch') { const on = !c.archived; if (await prefCall('orvix_archive_conversations', { convs: [c.conv_id], p_on: on }, on ? 'Chat diarsipkan' : 'Dikeluarkan dari arsip') && on) { if (history.state?.c) history.back(); else closeConv(); } }
    if (a === 'unread') { if (await prefCall('orvix_mark_unread', { convs: [c.conv_id], flag: true }, 'Ditandai belum dibaca')) { if (history.state?.c) history.back(); else closeConv(); } }
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
  const m = openModal({ title: 'Mulai', sheet: true, html: `<div class="col"><button class="btn" data-a="add">${icon('userplus')} Tambah teman dengan ID</button><button class="btn" data-a="contacts">${icon('contacts')} Kontak</button><button class="btn" data-a="friends">${icon('users')} Pilih dari teman / grup baru</button><button class="btn" data-a="gsearch">${icon('search')} Cari pesan</button><button class="btn" data-a="stars">${icon('star')} Pesan berbintang</button><button class="btn" data-a="glist">${icon('clock')} Pesan terjadwal ${isPremium(me) ? '' : '<span class="pill prem" style="margin-left:auto">Premium</span>'}</button></div>` });
  m.el.onclick = (e) => { const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return; m.close(); a === 'add' ? addFriendModal() : a === 'contacts' ? contactsModal() : a === 'gsearch' ? searchHere(true) : a === 'stars' ? openStarred() : a === 'glist' ? openScheduledList({ me, titleOf }) : friendsModal(); };
};

/* ---------- fitur chat: balas, reaksi, bintang, teruskan, suara, mengetik ---------- */
const nameOf = (id) => (id === me.id ? 'Kamu' : prof.get(id)?.display_name || 'Anggota');
const snippet = (m) => (m.media_type === 'audio' ? '🎤 Pesan suara' : m.media_type === 'image' ? '📷 Foto' : m.media_type === 'video' ? '🎥 Video' : m.content);
const rxLoaded = new Set();

function replyQuote(m) {
  if (!m.reply_to) return '';
  const o = msgs.find((x) => x.id === m.reply_to) || replyCache.get(m.reply_to);
  if (o === undefined) return `<div class="rq"><span class="grow"><b>Membalas</b><small>Memuat…</small></span></div>`;
  if (!o || o.deleted_at) return `<div class="rq off"><span class="grow"><b>Pesan</b><small class="ell">${icon('ban', 12)} Pesan ini telah dihapus</small></span></div>`;
  return `<div class="rq${o.sender_id === me.id ? ' mine' : ''}" data-rq="${o.id}"><span class="grow"><b>${esc(nameOf(o.sender_id))}</b><small class="ell">${esc(snippet(o))}</small></span></div>`;
}
async function loadReplyRefs() {
  const need = [...new Set(msgs.map((m) => m.reply_to).filter((i) => i && !msgs.some((x) => x.id === i) && !replyCache.has(i)))]; if (!need.length) return;
  const { data } = await sb.from('messages').select('id,sender_id,content,message_type,media_type,deleted_at').in('id', need.slice(0, 60));
  const got = new Map((data || []).map((r) => [r.id, r])); need.forEach((i) => replyCache.set(i, got.get(i) || null));
  await ensureProfiles([...got.values()].map((r) => r.sender_id)); render('auto');
}
function startReply(m) { if (!m || m._st) return; replyTo = m; paintReply(); $('#ci')?.focus({ preventScroll: true }); }
function clearReply() { replyTo = null; paintReply(); }
function paintReply() {
  const b = $('#replyBar'); if (!b) return;
  if (!replyTo) { b.classList.add('hide'); b.innerHTML = ''; return; }
  b.classList.remove('hide'); b.innerHTML = `<span class="rb-bar"></span><span class="grow"><b>Membalas ${esc(nameOf(replyTo.sender_id))}</b><small class="ell">${esc(snippet(replyTo))}</small></span><button class="ibtn" id="rbX" aria-label="Batalkan balasan">${icon('x', 18)}</button>`;
  $('#rbX').onclick = clearReply;
}
async function jumpTo(id) {
  for (let i = 0; i < 8 && !msgs.some((m) => m.id === id) && hasMore; i++) { try { await loadMsgs(activeId, true); } catch { break; } }
  loadExtras(activeId);
  const el = $(`#msgs [data-m="${CSS.escape(id)}"]`); if (!el) return toast('Pesan asli tidak ditemukan di riwayat chat ini.');
  el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1900);
}
function setRx(mid, uid, emoji) { const m = reacts.get(mid) || new Map(); emoji ? m.set(uid, emoji) : m.delete(uid); m.size ? reacts.set(mid, m) : reacts.delete(mid); }
async function loadExtras(id) {
  const ids = msgs.filter((m) => !m._st && !m.deleted_at && !rxLoaded.has(m.id)).map((m) => m.id).slice(-300);
  for (let i = 0; i < ids.length; i += 60) {
    const part = ids.slice(i, i + 60);
    const [r1, r2] = await Promise.all([sb.from('orvix_msg_reactions').select('message_id,user_id,emoji').in('message_id', part), sb.from('orvix_msg_starred').select('message_id').in('message_id', part)]);
    if (activeId !== id) return;
    if (!r1.error) { part.forEach((x) => rxLoaded.add(x)); (r1.data || []).forEach((r) => setRx(r.message_id, r.user_id, r.emoji)); }
    if (!r2.error) (r2.data || []).forEach((r) => starred.add(r.message_id));
  }
  await loadReplyRefs(); if (activeId === id) render('auto');
}
async function react(m, emoji) {
  const prev = reacts.get(m.id)?.get(me.id) || null, next = prev === emoji ? null : emoji;
  setRx(m.id, me.id, next); render('auto');
  const { error } = await sb.rpc('orvix_msg_react', { msg: m.id, emo: next });
  if (error) { setRx(m.id, me.id, prev); render('auto'); toast(dbErr(error, '17a-fitur-chat.sql'), 'error'); }
}
function reactionsModal(m) {
  const rx = reacts.get(m.id); if (!rx || !rx.size) return;
  ensureProfiles([...rx.keys()]).then(() => {
    const mm = openModal({ title: 'Reaksi', sheet: true, html: `<div class="col" style="gap:6px">${[...rx].map(([u, e]) => `<button class="row gap rxrow" data-u="${u}">${u === me.id ? avatar(me.display_name, me.avatar_url, 36) : avatar(prof.get(u)?.display_name, prof.get(u)?.avatar_url, 36)}<span class="grow" style="text-align:left">${esc(nameOf(u))}${u === me.id ? '<small class="dim" style="display:block">Ketuk untuk menghapus</small>' : ''}</span><span style="font-size:1.4rem">${esc(e)}</span></button>`).join('')}</div>` });
    mm.el.onclick = (e) => { const b = e.target.closest('[data-u]'); if (b && b.dataset.u === me.id) { mm.close(); react(m, rx.get(me.id)); } };
  });
}
async function starMsgs(rows, on) {
  const ids = rows.filter((m) => !m._st).map((m) => m.id); if (!ids.length) return;
  const { error } = await sb.rpc('orvix_msg_star', { msgs: ids, star: on }); if (error) return toast(dbErr(error, '17a-fitur-chat.sql'), 'error');
  ids.forEach((i) => (on ? starred.add(i) : starred.delete(i))); render('auto'); toast(on ? 'Pesan diberi bintang' : 'Bintang dilepas', 'success');
}
const openStarred = () => starredModal({ me, ensureProfiles, prof, titleOf, onOpen: async (cid, mid) => { if (cid !== activeId) await openConv(cid); jumpTo(mid); } });

async function forwardMsgs(rows) {
  rows = rows.filter((m) => !m._st && !m.deleted_at && m.message_type !== 'system').sort((a, b) => new Date(a.created_at) - new Date(b.created_at)); if (!rows.length) return;
  const ids = await forwardPicker({ convs: convs.filter((c) => !c.locked), name: convName, avOf: (c) => (c.conv_type === 'group' ? `<span class="av" style="width:36px;height:36px">${icon('users', 18)}</span>` : avatar(convName(c), c.other_avatar, 36)) });
  if (!ids.length) return; toast('Meneruskan…'); let ok = 0, fail = 0, why = '';
  for (const cid of ids) for (const m of rows) {
    try {
      let row = { conversation_id: cid, sender_id: me.id, content: m.content, message_type: m.message_type, forwarded: true };
      if (m.media_path) {
        const dest = `${cid}/${me.id}/${crypto.randomUUID()}.${m.media_path.split('.').pop()}`, { error: ce } = await sb.storage.from('chat-media').copy(m.media_path, dest); if (ce) throw ce;
        row = { ...row, media_type: m.media_type, media_path: dest }; if (m.duration_ms) row.duration_ms = m.duration_ms; if (m.wave) row.wave = m.wave;
      }
      const { error } = await sb.from('messages').insert(row); if (error) { if (row.media_path) sb.storage.from('chat-media').remove([row.media_path]).catch(() => {}); throw error; } ok++;
    } catch (e) { fail++; why = sendErr(e); }
  }
  refreshList();
  if (!fail) return toast(ids.length > 1 ? `Diteruskan ke ${ids.length} chat` : 'Pesan diteruskan', 'success');
  toast(ok ? `${ok} terkirim, ${fail} gagal. ${why}` : `Gagal meneruskan. ${why}`, 'error');
}

/* kolom ketik: emoji + pesan suara */
function bindComposerX(ci) {
  $('#emoBtn').onclick = (e) => { emojiPicker({ anchor: e.currentTarget, onPick: (em) => { const a = ci.selectionStart ?? ci.value.length, b = ci.selectionEnd ?? a; ci.value = ci.value.slice(0, a) + em + ci.value.slice(b); ci.selectionStart = ci.selectionEnd = a + em.length; ci.dispatchEvent(new Event('input')); ci.focus(); } }); };
  $('#micBtn').onclick = startRec; $('#recCancel').onclick = cancelRec; $('#recSend').onclick = sendRec;
  $('#recPause').onclick = () => { if (!rec) return; const b = $('#recPause'); if (rec.state === 'rec') { rec.pause(); b.innerHTML = icon('mic'); b.setAttribute('aria-label', 'Lanjutkan rekaman'); $('#cf').classList.add('paused'); } else { rec.resume(); b.innerHTML = icon('pause'); b.setAttribute('aria-label', 'Jeda rekaman'); $('#cf').classList.remove('paused'); } };
}
const lvBuf = [];
function paintLevel(l) {
  const box = $('#recLv'); if (!box) return; lvBuf.push(l); if (lvBuf.length > 26) lvBuf.shift();
  if (box.childElementCount !== 26) box.innerHTML = '<i></i>'.repeat(26); [...box.children].forEach((n, i) => { const v = lvBuf[lvBuf.length - 26 + i] ?? 0; n.style.height = 12 + Math.min(1, v * 2.2) * 88 + '%'; });
}
async function startRec() {
  if (rec || !activeId) return; const r = new Recorder(paintLevel); rec = r;
  try { await r.start(); } catch (e) { rec = null; return toast(e && (e.name === 'NotAllowedError' || e.name === 'SecurityError') ? 'Izin mikrofon ditolak. Aktifkan lewat pengaturan situs, lalu coba lagi.' : e && e.name === 'NotFoundError' ? 'Mikrofon tidak ditemukan.' : 'Mikrofon tidak bisa dipakai.', 'error'); }
  if (rec !== r) { r.cancel(); return; }
  lvBuf.length = 0; $('#cf').classList.add('recording'); $('#cf').classList.remove('paused'); $('#recPause').innerHTML = icon('pause'); $('#recT').textContent = '0:00'; navigator.vibrate?.(15);
  clearInterval(recT); recT = setInterval(() => { if (!rec) return clearInterval(recT); const t = $('#recT'); if (t) t.textContent = fmtDur(rec.elapsed); if (rec.elapsed >= 600000) sendRec(); }, 200);
}
function cancelRec() { if (rec) { rec.cancel(); rec = null; } clearInterval(recT); $('#cf')?.classList.remove('recording', 'paused'); }
async function sendRec() {
  if (!rec) return; const r = rec, cid = activeId; rec = null; clearInterval(recT); $('#cf')?.classList.remove('recording', 'paused');
  const out = await r.stop(); if (!out) return; if (out.duration_ms < 800) return toast('Rekaman terlalu singkat. Tahan lebih lama.', 'error');
  const rp = replyTo ? replyTo.id : null; clearReply();
  const tmp = { id: 'tmp-' + ++seq, conversation_id: cid, sender_id: me.id, content: 'Mengirim pesan suara…', created_at: new Date().toISOString(), _st: 'sending', reply_to: rp };
  if (cid === activeId) { msgs.push(tmp); render('bottom'); }
  try {
    const row = await sendMessage({ conv: cid, me: me.id, audio: out, replyTo: rp });
    if (cid !== activeId) return refreshList();
    msgs = msgs.filter((m) => m !== tmp); if (!msgs.some((x) => x.id === row.id)) msgs.push(row); msgs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)); render('bottom'); refreshList();
  } catch (e) { msgs = msgs.filter((m) => m !== tmp); render('auto'); toast(sendErr(e), 'error'); }
}

/* sedang mengetik (Realtime Broadcast; bila Broadcast dibatasi, fitur ini diam saja) */
function subscribeTyping(id) {
  closeTyping();
  try {
    typingCh = track(sb.channel('typing-' + id, { config: { broadcast: { self: false } } }));
    typingCh.on('broadcast', { event: 'typing' }, ({ payload }) => { if (!payload || payload.u === me.id || id !== activeId) return; typers.set(payload.u, Date.now() + 4000); paintSub(); setTimeout(paintSub, 4200); }).subscribe();
  } catch { typingCh = null; }
}
function closeTyping() { const c = typingCh; typingCh = null; typers.clear(); if (c) untrack(c); }
function sendTyping() { if (!typingCh || typingCh.state !== 'joined' || Date.now() - typingT < 2500) return; typingT = Date.now(); typingCh.send({ type: 'broadcast', event: 'typing', payload: { u: me.id } }).catch(() => {}); }
const stopTypingNow = () => { typingT = 0; };

/* geser pesan ke kanan = balas */
function bindSwipeReply(box) {
  let el = null, x0 = 0, y0 = 0, dx = 0, on = false;
  box.addEventListener('touchstart', (e) => { const it = e.target.closest('.msg[data-m]'); if (!it || msel.size || e.touches.length !== 1 || e.target.closest('.vn,video,button')) { el = null; return; } el = it; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; on = false; }, { passive: true });
  box.addEventListener('touchmove', (e) => {
    if (!el) return; const t = e.touches[0], ddx = t.clientX - x0, ddy = t.clientY - y0;
    if (!on) { if (Math.abs(ddy) > 12 && Math.abs(ddy) > Math.abs(ddx)) { el = null; return; } if (ddx > 12) on = true; else return; }
    dx = Math.max(0, Math.min(72, ddx)); el.style.transform = `translateX(${dx}px)`; el.classList.toggle('swp', dx >= 56); clearTimeout(mlpT);
  }, { passive: true });
  const end = () => { if (!el) return; const m = msgs.find((x) => x.id === el.dataset.m), fire = dx >= 56; el.style.transform = ''; el.classList.remove('swp'); if (fire && m && selectable(m)) { navigator.vibrate?.(10); startReply(m); mlpFired = true; setTimeout(() => { mlpFired = false; }, 500); } el = null; dx = 0; };
  box.addEventListener('touchend', end); box.addEventListener('touchcancel', end);
}
function paintToBottom() {
  const b = $('#toBottom'); if (!b) return; const el = $('#msgs'), far = !!el && el.scrollHeight - el.scrollTop - el.clientHeight > 320;
  if (!far) newBelow = 0; b.classList.toggle('hide', !far); const n = $('#tbN'); if (n) { n.textContent = newBelow > 99 ? '99+' : newBelow; n.classList.toggle('hide', !newBelow); }
}

closeConv(); layout.classList.remove('open');
await Promise.all([loadConvs(), loadBlocked().catch(() => {})]); refreshReq();
(async () => {   // pemberitahuan dari moderator/verifikasi (sekali tampil)
  const { data } = await sb.from('user_notices').select('id,kind,title,body,created_at').is('read_at', null).order('created_at', { ascending: false }).limit(5);
  if (!data?.length) return;
  const m = openModal({ title: 'Pemberitahuan', html: data.map((n) => `<div class="card" style="margin-bottom:10px"><b>${icon(n.kind === 'warning' ? 'flag' : 'badge', 16)} ${esc(n.title)}</b><p class="muted" style="margin-top:6px">${esc(n.body)}</p><p class="dim" style="margin-top:4px">${relTime(n.created_at)}</p></div>`).join('') + '<button class="btn primary block" data-ok>Mengerti</button>', onClose: () => sb.rpc('orvix_ack_notices').then(() => {}, () => {}) });
  m.el.querySelector('[data-ok]').onclick = m.close;
})().catch(() => {});
if (new URLSearchParams(location.search).get('req') === '1') setTimeout(() => requestsModal(), 400);   // dari notifikasi permintaan pertemanan
const deep = new URLSearchParams(location.search).get('c'); if (deep && convs.some((c) => c.conv_id === deep)) openConv(deep, false).catch(() => {});
