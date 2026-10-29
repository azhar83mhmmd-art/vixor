// Halaman info grup: header, tab Anggota & Pengaturan, aksi admin. Semua perubahan lewat RPC yang memvalidasi di server (19b).
import { sb, errMsg, fetchFriendships } from './supabase.js';
import { $, $$, esc, icon, avatar, badgesHtml, toast, setBusy, openModal, confirmDialog, relTime, debounce } from './utils.js';
import { cropImage } from './cropper.js';

let deps = {};
export const initGroupInfo = (d) => { deps = d; };       // { me, conv, shareInvite, disappearModal, callGroup, searchChat, exportChat, clearChat, toggleFav, isFav, openMute, onChanged, onLeft, startChat, report }

const POLICY = { all: 'Semua anggota', admins: 'Hanya admin' };
const DISAPPEAR = (s) => (!s ? 'Nonaktif' : s >= 604800 ? '7 hari' : s >= 86400 ? '24 jam' : s >= 3600 ? '1 jam' : s + ' detik');
const isAdmin = (r) => r === 'owner' || r === 'admin';
const sqlHint = (e) => (/function .* does not exist|orvix_group_|column .* does not exist|send_policy|schema cache/i.test(String(e?.message || e)) ? 'Fitur grup lanjutan belum aktif di database. Jalankan sql-parts/19b-grup-admin.sql di SQL Editor Supabase, lalu muat ulang.' : errMsg(e));

export async function openGroupInfo(c) {
  const prev = document.activeElement;
  const el = document.createElement('div'); el.className = 'pscreen gi'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'Info grup ' + (c.title || ''));
  el.innerHTML = `<header class="ps-top"><button class="ibtn" data-back aria-label="Kembali">${icon('back', 22)}</button><h2 id="giT">Info grup</h2></header><div class="ps-scroll" id="giB"><div class="empty" style="padding:60px"><p class="dim">Memuat…</p></div></div>`;
  document.body.append(el); document.body.classList.add('noscroll'); history.pushState({ ps: 1 }, '');
  let gone = false, G = null, tab = 'members', q = '';
  const body = $('#giB', el);
  const remove = () => { if (gone) return; gone = true; removeEventListener('popstate', onPop); document.removeEventListener('keydown', onKey); el.classList.add('out'); setTimeout(() => { el.remove(); if (!document.querySelector('.modal-back,.pscreen,.pc-back')) document.body.classList.remove('noscroll'); prev?.focus?.({ preventScroll: true }); }, 180); };
  const close = () => { if (gone) return; if (history.state?.ps) history.back(); else remove(); };
  const onPop = () => remove(); addEventListener('popstate', onPop);
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.modal-back,.pc-back,.dd-back')) close(); }; document.addEventListener('keydown', onKey);
  $('[data-back]', el).onclick = close;

  const load = async (quiet) => {
    try {
      const { data, error } = await sb.rpc('orvix_group_overview', { conv: c.conv_id }); if (error) throw error;
      G = data; deps.onChanged?.(G); paint();
    } catch (e) {
      if (quiet && G) return toast(sqlHint(e), 'error');
      body.innerHTML = `<div class="empty" style="padding:50px 24px"><h3>Gagal memuat info grup</h3><p class="dim">${esc(sqlHint(e))}</p><button class="btn" id="giR" style="margin-top:12px">Coba lagi</button></div>`; $('#giR', el).onclick = () => load();
    }
  };

  const act = async (fn, ok) => { try { const r = await fn(); if (ok) toast(ok, 'success'); await load(true); return r; } catch (e) { toast(sqlHint(e), 'error'); return null; } };

  function paint() {
    const my = G.my_role, adm = isAdmin(my), canInfo = adm || G.info_policy === 'all', n = G.members.length;
    const ar = $('.ps-scroll', el).scrollTop;
    body.innerHTML = `<section class="gi-hero">
        <div class="gi-av"><button class="ps-av ${G.avatar_url ? 'has' : ''}" style="all:unset;cursor:${G.avatar_url ? 'zoom-in' : 'default'};display:block;border-radius:50%" ${G.avatar_url ? 'data-zoom' : 'tabindex="-1"'} aria-label="Foto grup">${G.avatar_url ? avatar(G.title, G.avatar_url, 132) : `<span class="av" style="width:132px;height:132px">${icon('users', 56)}</span>`}</button>
          ${canInfo ? `<button class="gi-cam" data-photo aria-label="Ganti foto grup">${icon('camera', 18)}</button>` : ''}</div>
        <h1 class="gi-name">${esc(G.title)}${canInfo ? ` <button class="ibtn" data-rename aria-label="Ubah nama grup" style="vertical-align:middle">${icon('edit', 18)}</button>` : ''}</h1>
        <p class="gi-sub">Grup · <span id="giN">${n}</span> anggota</p>
        <p class="gi-desc">${G.description ? esc(G.description) + (canInfo ? ` <button data-desc>Ubah</button>` : '') : canInfo ? '<button data-desc>Tambah deskripsi grup</button>' : '<span class="dim">Belum ada deskripsi</span>'}</p>
        <div class="gi-quick">
          <button class="pa" data-call="voice"><span>${icon('phone', 22)}</span><small>Suara</small></button>
          <button class="pa" data-call="video"><span>${icon('video', 22)}</span><small>Video</small></button>
          <button class="pa" data-share><span>${icon('share', 22)}</span><small>Bagikan</small></button>
          <button class="pa" data-find><span>${icon('search', 22)}</span><small>Cari</small></button>
        </div></section>
      <div class="gi-tabs" role="tablist"><button role="tab" data-tab="members" aria-selected="${tab === 'members'}">Anggota</button><button role="tab" data-tab="settings" aria-selected="${tab === 'settings'}">Pengaturan</button></div>
      <div class="gi-pane" role="tabpanel">${tab === 'members' ? membersHTML(adm) : settingsHTML(adm, my)}</div>`;
    $('.ps-scroll', el).scrollTop = ar; wire();
  }

  const badgeHTML = (m) => badgesHtml(m, 15, true);
  function membersHTML(adm) {
    const f = q.trim().toLowerCase(), list = G.members.filter((m) => !f || [m.display_name, m.username, m.orvix_id].some((s) => String(s || '').toLowerCase().includes(f)));
    return `<div class="gi-bar"><span class="grow">${G.members.length} anggota</span><button class="ibtn" data-msearch aria-label="Cari anggota" aria-expanded="${!!q || el.dataset.ms === '1'}">${icon('search', 20)}</button></div>
      <div class="gi-search ${q || el.dataset.ms === '1' ? '' : 'hide'}">${icon('search', 16)}<input id="giQ" type="search" placeholder="Cari nama, username, atau ID" aria-label="Cari anggota" value="${esc(q)}" autocomplete="off"></div>
      ${adm ? `<button class="gi-row" data-add><span class="gi-ic" style="background:var(--blue);color:#fff">${icon('userplus', 22)}</span><span class="t"><b>Tambah anggota</b></span></button>` : ''}
      ${list.map((m) => `<button class="gi-row" data-mem="${m.user_id}" aria-label="Anggota ${esc(m.display_name)}">${avatar(m.display_name, m.avatar_url, 44)}<span class="t"><b>${esc(m.display_name)}${m.user_id === deps.me.id ? ' <span class="dim">(Anda)</span>' : ''} ${badgeHTML(m)}</b><small>@${esc(m.username)} · ID ${esc(m.orvix_id)}</small></span>${m.role === 'owner' ? '<span class="gi-pill">Pemilik</span>' : m.role === 'admin' ? '<span class="gi-pill">Admin grup</span>' : ''}</button>`).join('') || '<p class="dim" style="padding:20px 16px">Tidak ada anggota yang cocok.</p>'}
      <button class="gi-link" data-changes>Lihat perubahan anggota</button>`;
  }

  function settingsHTML(adm, my) {
    const row = (k, ic, t, sub, cls = '') => `<button class="gi-set ${cls}" data-s="${k}">${icon(ic, 22)}<span class="t">${esc(t)}${sub ? `<small>${esc(sub)}</small>` : ''}</span></button>`;
    return `${row('media', 'image', 'Visibilitas media', 'Foto & video grup tampil di galeri perangkat sesuai pengaturan perangkatmu')}
      ${row('disappear', 'timer', 'Pesan sementara', DISAPPEAR(G.disappear_secs))}
      ${row('send', 'chat', 'Izin mengirim pesan', POLICY[G.send_policy] + (adm ? '' : ' (hanya admin yang bisa mengubah)'))}
      ${row('info', 'edit', 'Izin mengedit info grup', POLICY[G.info_policy] + (adm ? '' : ' (hanya admin yang bisa mengubah)'))}
      ${row('invite', 'link', 'Link undangan', 'Bagikan link untuk mengundang orang')}
      ${row('mute', 'mute', 'Notifikasi grup', 'Bisukan atau aktifkan notifikasi')}
      ${row('similar', 'userplus', 'Buat grup serupa', 'Mulai dengan anggota yang sama yang bisa ditambah atau dikeluarkan')}
      ${row('fav', 'star', deps.isFav?.() ? 'Lepas sematan grup' : 'Sematkan grup (favorit) di daftar chat', '')}
      ${row('find', 'search', 'Cari di percakapan', '')}
      ${row('export', 'share', 'Ekspor obrolan', 'Simpan pesan grup sebagai berkas teks di perangkat ini')}
      <div class="gi-sec">Zona sensitif</div>
      ${row('clear', 'trash', 'Bersihkan obrolan', 'Hanya untuk kamu — anggota lain tetap melihat pesannya', 'danger')}
      ${row('leave', 'logout', 'Keluar dari grup', my === 'owner' ? 'Kepemilikan akan dialihkan ke anggota lain' : '', 'danger')}
      ${my === 'owner' ? row('delete', 'ban', 'Hapus grup', 'Menghapus grup dan semua pesannya untuk SEMUA anggota', 'danger') : ''}`;
  }

  function wire() {
    $$('[data-tab]', el).forEach((b) => (b.onclick = () => { tab = b.dataset.tab; paint(); }));
    $$('[data-call]', el).forEach((b) => (b.onclick = () => deps.callGroup(b.dataset.call)));
    $('[data-share]', el).onclick = () => deps.shareInvite();
    $('[data-find]', el).onclick = () => { close(); setTimeout(() => deps.searchChat?.(), 250); };
    $('[data-zoom]', el)?.addEventListener('click', () => { const d = document.createElement('div'); d.className = 'lbx'; d.innerHTML = `<button class="ibtn" aria-label="Tutup">${icon('x', 22)}</button><img src="${esc(G.avatar_url)}" alt="">`; d.onclick = () => d.remove(); document.body.append(d); });
    $('[data-photo]', el)?.addEventListener('click', changePhoto);
    $('[data-rename]', el)?.addEventListener('click', renameModal);
    $('[data-desc]', el)?.addEventListener('click', descModal);
    // anggota
    $('[data-msearch]', el)?.addEventListener('click', () => { el.dataset.ms = el.dataset.ms === '1' ? '0' : '1'; paint(); $('#giQ', el)?.focus(); });
    $('#giQ', el)?.addEventListener('input', debounce((e) => { q = e.target.value; const pos = e.target.selectionStart; paint(); const i = $('#giQ', el); i.focus(); i.setSelectionRange(pos, pos); }, 180));
    $('[data-add]', el)?.addEventListener('click', addMembersModal);
    $$('[data-mem]', el).forEach((b) => (b.onclick = () => memberMenu(G.members.find((m) => m.user_id === b.dataset.mem))));
    $('[data-changes]', el)?.addEventListener('click', changesModal);
    $$('[data-s]', el).forEach((b) => (b.onclick = () => settingAction(b.dataset.s, b)));
  }

  /* ---- info grup ---- */
  async function changePhoto() {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/jpeg,image/png,image/webp';
    inp.onchange = async () => {
      const f = inp.files?.[0]; if (!f) return;
      try {
        const blob = await cropImage(f, { aspect: 1, outW: 512, round: true, title: 'Foto grup' }); if (!blob) return;
        const path = `${deps.me.id}/gr/${c.conv_id}-${Date.now()}.${blob.type === 'image/webp' ? 'webp' : 'jpg'}`;
        const up = await sb.storage.from('avatars').upload(path, blob, { contentType: blob.type, cacheControl: '31536000' }); if (up.error) throw up.error;
        const url = sb.storage.from('avatars').getPublicUrl(path).data.publicUrl;
        const { error } = await sb.rpc('orvix_group_update_info', { conv: c.conv_id, p_avatar_url: url, p_set_avatar: true });
        if (error) { sb.storage.from('avatars').remove([path]).catch(() => {}); throw error; }
        toast('Foto grup diperbarui', 'success'); await load(true);
      } catch (e) { toast(sqlHint(e), 'error'); }
    };
    inp.click();
  }
  function textModal(title, label, val, max, multi, onSave) {
    const m = openModal({ title, html: `<form id="tf"><div class="field"><label for="tv">${esc(label)}</label>${multi ? `<textarea class="inp" id="tv" maxlength="${max}" rows="4">${esc(val || '')}</textarea>` : `<input class="inp" id="tv" maxlength="${max}" value="${esc(val || '')}">`}</div><div class="row end gap"><button type="button" class="btn ghost" data-n>Batal</button><button class="btn primary" id="ts">Simpan</button></div></form>` });
    $('[data-n]', m.el).onclick = () => m.close();
    $('#tf', m.el).onsubmit = async (e) => { e.preventDefault(); const b = $('#ts', m.el); setBusy(b, true); const ok = await onSave($('#tv', m.el).value.trim()); setBusy(b, false); if (ok !== false) m.close(); };
  }
  function renameModal() { textModal('Ubah nama grup', 'Nama grup', G.title, 60, false, async (v) => { if (!v) { toast('Nama grup tidak boleh kosong', 'error'); return false; } return (await act(() => rpcOk('orvix_group_update_info', { conv: c.conv_id, p_title: v }), 'Nama grup diperbarui')) !== null; }); }
  function descModal() { textModal('Deskripsi grup', 'Deskripsi', G.description, 300, true, async (v) => (await act(() => rpcOk('orvix_group_update_info', { conv: c.conv_id, p_description: v }), 'Deskripsi diperbarui')) !== null); }
  const rpcOk = async (fn, args) => { const r = await sb.rpc(fn, args); if (r.error) throw r.error; return r.data ?? true; };

  /* ---- anggota ---- */
  async function addMembersModal() {
    const m = openModal({ title: 'Tambah anggota', wide: true, html: `<div class="gi-search" style="margin:0 0 10px">${icon('search', 16)}<input id="aq" type="search" placeholder="Cari teman" aria-label="Cari teman" autocomplete="off"></div><div id="al" class="col" style="gap:2px;max-height:50vh;overflow:auto"><p class="dim">Memuat teman…</p></div><div class="row end gap" style="margin-top:12px"><button class="btn ghost" data-n>Batal</button><button class="btn primary" id="ago" disabled>Tambahkan</button></div>` });
    const sel = new Set(), have = new Set(G.members.map((x) => x.user_id)); let friends = [];
    const draw = () => { const f = $('#aq', m.el).value.trim().toLowerCase(); const rows = friends.filter((x) => !have.has(x.other.id) && (!f || (x.other.display_name + ' ' + x.other.username).toLowerCase().includes(f)));
      $('#al', m.el).innerHTML = rows.map((x) => `<label class="gi-row" style="cursor:pointer"><input type="checkbox" data-id="${x.other.id}" ${sel.has(x.other.id) ? 'checked' : ''} style="width:18px;height:18px">${avatar(x.other.display_name, x.other.avatar_url, 40)}<span class="t"><b>${esc(x.other.display_name)}</b><small>@${esc(x.other.username)}</small></span></label>`).join('') || '<p class="dim" style="padding:12px 4px">Tidak ada teman yang bisa ditambahkan.</p>';
      $('#ago', m.el).disabled = !sel.size; $('#ago', m.el).textContent = sel.size ? `Tambahkan (${sel.size})` : 'Tambahkan'; };
    try { friends = (await fetchFriendships(deps.me.id)).filter((f) => f.status === 'accepted'); } catch (e) { $('#al', m.el).innerHTML = `<p class="err">${esc(errMsg(e))}</p>`; return; }
    draw(); $('#aq', m.el).oninput = debounce(draw, 150);
    $('#al', m.el).onchange = (e) => { const i = e.target.closest('[data-id]'); if (!i) return; i.checked ? sel.add(i.dataset.id) : sel.delete(i.dataset.id); draw(); };
    $('[data-n]', m.el).onclick = () => m.close();
    $('#ago', m.el).onclick = async (e) => { setBusy(e.currentTarget, true); const r = await act(() => rpcOk('orvix_group_add_members', { conv: c.conv_id, uids: [...sel] })); if (r === null) return setBusy(e.currentTarget, false); toast(r > 0 ? `${r} anggota ditambahkan` : 'Tidak ada anggota yang bisa ditambahkan', r > 0 ? 'success' : 'error'); m.close(); };
  }

  function memberMenu(mem) {
    if (!mem) return; const my = G.my_role, self = mem.user_id === deps.me.id;
    const canKick = !self && mem.role !== 'owner' && (my === 'owner' || (my === 'admin' && mem.role === 'member'));
    const canRole = !self && my === 'owner' && mem.role !== 'owner';
    const m = openModal({ title: mem.display_name, sheet: true, html: `<div class="gi-menu">
      <button data-a="view">${icon('user', 22)} Lihat profil</button>${self ? '' : `<button data-a="dm">${icon('chat', 22)} Kirim pesan pribadi</button>`}
      ${canRole ? `<button data-a="role">${icon('shield', 22)} ${mem.role === 'admin' ? 'Cabut status admin' : 'Jadikan admin grup'}</button>` : ''}
      ${canKick ? `<button class="danger" data-a="kick">${icon('logout', 22)} Keluarkan dari grup</button>` : ''}
      ${self ? '' : `<button class="danger" data-a="rep">${icon('flag', 22)} Laporkan akun</button>`}</div>` });
    m.el.onclick = async (e) => {
      const b = e.target.closest('[data-a]'); if (!b) return; const a = b.dataset.a;
      if (a === 'view') { m.close(); return deps.viewProfile(mem.user_id); }
      if (a === 'dm') { m.close(); close(); return setTimeout(() => deps.startChat(mem.user_id).catch((x) => toast(errMsg(x), 'error')), 220); }
      if (a === 'rep') { m.close(); return deps.report?.(mem.user_id, mem.display_name); }
      if (a === 'role') { const to = mem.role === 'admin' ? 'member' : 'admin'; m.close(); if (!(await confirmDialog({ title: to === 'admin' ? 'Jadikan admin?' : 'Cabut status admin?', message: `${esc(mem.display_name)} ${to === 'admin' ? 'akan bisa menambah/mengeluarkan anggota dan mengubah info grup.' : 'tidak lagi menjadi admin grup.'}`, confirmText: 'Ya' }))) return; return act(() => rpcOk('orvix_group_set_role', { conv: c.conv_id, uid: mem.user_id, p_role: to }), to === 'admin' ? 'Dijadikan admin' : 'Status admin dicabut'); }
      if (a === 'kick') { m.close(); if (!(await confirmDialog({ title: `Keluarkan ${mem.display_name}?`, message: 'Anggota ini tidak akan menerima pesan grup lagi. Pesan lama miliknya tetap ada.', confirmText: 'Keluarkan', danger: true }))) return; return act(() => rpcOk('orvix_group_remove_member', { conv: c.conv_id, uid: mem.user_id }), 'Anggota dikeluarkan'); }
    };
  }

  async function changesModal() {
    const m = openModal({ title: 'Perubahan anggota', html: '<div id="cl"><p class="dim">Memuat…</p></div>' });
    const ACT = { add: 'menambahkan', remove: 'mengeluarkan', leave: 'keluar dari grup', promote: 'menjadikan admin', demote: 'mencabut admin', owner: 'menjadi pemilik grup' };
    try {
      const { data, error } = await sb.rpc('orvix_group_changes', { conv: c.conv_id, lim: 60 }); if (error) throw error;
      $('#cl', m.el).innerHTML = (data || []).map((r) => { const a = r.actor_name || 'Seseorang', t = r.target_name || 'anggota'; const s = r.action === 'leave' ? `${a} keluar dari grup` : r.action === 'owner' ? `${t} menjadi pemilik grup` : `${a} ${ACT[r.action]} ${t}`; return `<div class="gi-log">${esc(s)}<small>${esc(relTime(r.created_at))}</small></div>`; }).join('') || '<p class="dim">Belum ada perubahan.</p>';
    } catch (e) { $('#cl', m.el).innerHTML = `<p class="err">${esc(sqlHint(e))}</p>`; }
  }

  /* ---- pengaturan ---- */
  function policyModal(kind) {
    const key = kind === 'send' ? 'send_policy' : 'info_policy', title = kind === 'send' ? 'Izin mengirim pesan' : 'Izin mengedit info grup';
    if (!isAdmin(G.my_role)) return toast('Hanya admin grup yang bisa mengubah ini.', 'error');
    const m = openModal({ title, sheet: true, html: `<div class="gi-menu">${['all', 'admins'].map((v) => `<button data-v="${v}">${icon(G[key] === v ? 'check' : 'chev', 20)} ${POLICY[v]}</button>`).join('')}</div>` });
    m.el.onclick = (e) => { const b = e.target.closest('[data-v]'); if (!b) return; m.close(); const next = { send: G.send_policy, info: G.info_policy, [kind]: b.dataset.v }; act(() => rpcOk('orvix_group_set_policy', { conv: c.conv_id, p_send: next.send, p_info: next.info }), 'Pengaturan disimpan'); };
  }
  async function settingAction(k, btn) {
    if (k === 'send' || k === 'info') return policyModal(k);
    if (k === 'disappear') return deps.disappearModal();
    if (k === 'invite') return deps.shareInvite();
    if (k === 'mute') return deps.openMute?.();
    if (k === 'find') { close(); return setTimeout(() => deps.searchChat?.(), 250); }
    if (k === 'media') return toast('Foto & video grup selalu tampil di chat; unduhan ke galeri mengikuti pengaturan perangkatmu.');
    if (k === 'export') { setBusy(btn, true); try { await deps.exportChat(); } finally { setBusy(btn, false); } return; }
    if (k === 'fav') { await deps.toggleFav?.(); return paint(); }
    if (k === 'similar') { close(); return setTimeout(() => deps.similarGroup?.(G.members.map((m) => m.user_id).filter((i) => i !== deps.me.id)), 250); }
    if (k === 'clear') { if (!(await confirmDialog({ title: 'Bersihkan obrolan?', message: 'Pesan grup ini dihapus <b>hanya dari tampilanmu</b>. Anggota lain tetap melihat semua pesan.', confirmText: 'Bersihkan', danger: true }))) return; if (await deps.clearChat?.()) { close(); setTimeout(() => deps.afterClear?.(), 260); } return; }
    if (k === 'leave') { if (!(await confirmDialog({ title: 'Keluar dari grup?', message: G.my_role === 'owner' ? 'Kamu pemilik grup ini. Kepemilikan akan dialihkan otomatis ke admin/anggota terlama.' : 'Kamu tidak akan menerima pesan grup lagi.', confirmText: 'Keluar', danger: true }))) return; const { error } = await sb.rpc('leave_group', { conv: c.conv_id }); if (error) return toast(sqlHint(error), 'error'); close(); return deps.onLeft?.(); }
    if (k === 'delete') {
      if (!(await confirmDialog({ title: 'Hapus grup untuk semua anggota?', message: `Grup <b>${esc(G.title)}</b> beserta semua pesannya akan dihapus permanen untuk <b>semua ${G.members.length} anggota</b>. Tindakan ini tidak bisa dibatalkan.`, confirmText: 'Lanjut', danger: true }))) return;
      const m = openModal({ title: 'Konfirmasi hapus grup', html: `<p class="muted">Ketik <b>HAPUS</b> untuk memastikan.</p><input class="inp" id="dc" autocomplete="off" aria-label="Ketik HAPUS"><div class="row end gap" style="margin-top:12px"><button class="btn ghost" data-n>Batal</button><button class="btn danger" id="dgo" disabled>Hapus grup</button></div>` });
      $('#dc', m.el).oninput = (e) => ($('#dgo', m.el).disabled = e.target.value.trim() !== 'HAPUS'); $('[data-n]', m.el).onclick = () => m.close();
      $('#dgo', m.el).onclick = async (e) => { setBusy(e.currentTarget, true); const { error } = await sb.rpc('orvix_group_delete', { conv: c.conv_id }); if (error) { setBusy(e.currentTarget, false); return toast(sqlHint(error), 'error'); } m.close(); close(); deps.onLeft?.(); toast('Grup dihapus', 'success'); };
    }
  }

  // realtime ringan: segarkan saat anggota/peran berubah (hanya data yang boleh diakses anggota: RLS members_select)
  const ch = sb.channel('gi-' + c.conv_id).on('postgres_changes', { event: '*', schema: 'public', table: 'conversation_members', filter: `conversation_id=eq.${c.conv_id}` }, debounce(() => { if (!gone) load(true); }, 400)).subscribe();
  const mo = new MutationObserver(() => { if (!document.body.contains(el)) { sb.removeChannel(ch); mo.disconnect(); } }); mo.observe(document.body, { childList: true });
  await load();
  return { close };
}
