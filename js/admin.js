// Panel admin. Semua data & aksi lewat RPC admin_api (SECURITY DEFINER; role admin diperiksa ulang dari database). Tanpa Edge Function.
import { sb, requireAuth, errMsg, purgeUserFiles } from './supabase.js';
import { $, $$, esc, icon, avatar, nameWithBadge, verifiedBadge, toast, setBusy, openModal, confirmDialog, debounce, injectSprite } from './utils.js';

const { profile: me } = await requireAuth({ admin: true });
injectSprite();
const main = $('#main'), side = $('#side');
let view = 'dash';
const state = { q: '', filter: 'all', page: 0 };

async function api(action, params = {}) {
  if (action === 'delete_user') await purgeUserFiles(params.user_id).catch(() => {});   // bersihkan berkas Storage lebih dulu
  const { data, error } = await sb.rpc('admin_api', { p: { action, ...params } });
  if (error) throw new Error(/admin_api/.test(error.message) && /function|schema cache/i.test(error.message) ? 'Fungsi admin belum terpasang di database. Jalankan perbaikan-bagian-13.sql di Supabase SQL Editor.' : errMsg(error));
  return data;
}
const fmtDT = (d) => (d ? new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(d)) : '-');
const NAV = [['dash', 'dash', 'Dashboard'], ['users', 'users', 'Pengguna'], ['reports', 'flag', 'Laporan'], ['verif', 'badge', 'Verifikasi'], ['audit', 'list', 'Audit log']];

function drawSide() {
  side.innerHTML = `<div class="brand"><img src="/assets/mark.png" alt="" width="30" height="30">ORVIX Admin</div>${NAV.map(([k, i, l]) => `<button data-v="${k}" ${k === view ? 'aria-current="true"' : ''}>${icon(i, 18)} ${l}</button>`).join('')}<a class="back" href="/chat">${icon('back', 18)} Ke aplikasi</a>`;
  $$('[data-v]', side).forEach((b) => b.onclick = () => { view = b.dataset.v; state.page = 0; drawSide(); go(); });
}
const fail = (e) => { main.innerHTML = `<div class="empty card"><h3>Gagal memuat</h3><p>${esc(errMsg(e))}</p><button class="btn" id="rt" style="margin-top:12px">Coba lagi</button></div>`; $('#rt').onclick = go; };
const go = () => ({ dash, users, reports, verif, audit }[view])().catch(fail);

async function dash() {
  main.innerHTML = '<h1 style="margin-bottom:16px">Dashboard</h1><p class="dim">Memuat statistik…</p>';
  const s = await api('stats');
  const cards = [['Total pengguna', s.users], ['Aktif 24 jam', s.active24h], ['Terverifikasi', s.verified], ['Dinonaktifkan', s.suspended], ['Percakapan', s.conversations], ['Pesan', s.messages], ['Laporan belum ditangani', s.openReports]];
  main.innerHTML = `<h1 style="margin-bottom:16px">Dashboard</h1><div class="stats">${cards.map(([l, n]) => `<div class="stat"><b>${Number(n).toLocaleString('id-ID')}</b><span>${l}</span></div>`).join('')}</div><p class="dim">Angka dihitung langsung dari database. “Aktif 24 jam” dihitung dari aktivitas terakhir aplikasi (heartbeat) setiap pengguna.</p>`;
}

async function users() {
  main.innerHTML = `<h1 style="margin-bottom:14px">Pengguna</h1><div class="row gap" style="flex-wrap:wrap;margin-bottom:14px"><input class="inp" id="uq" type="search" placeholder="Cari nama, username, atau ID ORVIX" aria-label="Cari pengguna" style="flex:1;min-width:220px" value="${esc(state.q)}"><select class="inp" id="uf" aria-label="Filter" style="width:auto"><option value="all">Semua</option><option value="verified">Terverifikasi</option><option value="unverified">Belum verified</option><option value="active">Aktif</option><option value="suspended">Dinonaktifkan</option></select></div><div id="ul"><p class="dim">Memuat…</p></div>`;
  $('#uf').value = state.filter;
  $('#uq').oninput = debounce((e) => { state.q = e.target.value; state.page = 0; fetchUsers(); }, 400);
  $('#uf').onchange = (e) => { state.filter = e.target.value; state.page = 0; fetchUsers(); };
  await fetchUsers();
}
async function fetchUsers() {
  const box = $('#ul'); if (!box) return;
  try {
    const r = await api('list_users', { q: state.q, filter: state.filter, page: state.page, pageSize: 20 });
    const pages = Math.max(1, Math.ceil(r.total / r.pageSize));
    box.innerHTML = (r.users.length ? `<div class="tbl">${r.users.map((u) => `<div class="tr">${avatar(u.display_name, u.avatar_url, 40)}<span class="grow">${nameWithBadge(u.display_name, u.is_verified)}<br><span class="dim">@${esc(u.username)} · ID ${esc(u.orvix_id)} · ${fmtDT(u.created_at)}</span></span>${u.role === 'admin' ? '<span class="pill">admin</span>' : ''}<span class="pill ${u.is_suspended ? 'bad' : 'good'}">${u.is_suspended ? 'Dinonaktifkan' : 'Aktif'}</span><button class="btn sm" data-u="${u.id}">Detail</button></div>`).join('')}</div>` : '<div class="empty card"><p>Tidak ada pengguna yang cocok.</p></div>') + `<div class="row between" style="margin-top:14px"><span class="dim">${r.total} pengguna · halaman ${state.page + 1}/${pages}</span><span class="row gap"><button class="btn sm" id="pp" ${state.page === 0 ? 'disabled' : ''}>Sebelumnya</button><button class="btn sm" id="pn" ${state.page + 1 >= pages ? 'disabled' : ''}>Berikutnya</button></span></div>`;
    $('#pp') && ($('#pp').onclick = () => { state.page--; fetchUsers(); }); $('#pn') && ($('#pn').onclick = () => { state.page++; fetchUsers(); });
    $$('[data-u]', box).forEach((b) => b.onclick = () => userModal(b.dataset.u));
  } catch (e) { box.innerHTML = `<p class="err">${esc(errMsg(e))}</p>`; }
}

async function userModal(id) {
  const m = openModal({ title: 'Detail pengguna', wide: true, html: '<p class="dim">Memuat…</p>' });
  const draw = async () => {
    const d = await api('get_user', { user_id: id }), u = d.user, self = u.id === me.id, isSuper = !!(await sb.rpc('is_super_admin')).data;
    m.el.innerHTML = `<div class="row gap" style="margin-bottom:14px">${avatar(u.display_name, u.avatar_url, 64)}<span class="grow"><h3>${nameWithBadge(u.display_name, u, 18, true, u.id)}</h3><span class="dim">@${esc(u.username)} · ID ORVIX ${esc(u.orvix_id)}</span></span></div>
    <div class="card sm col" style="gap:6px;margin-bottom:14px"><div>Email: <b>${esc(d.email || '-')}</b> ${d.email_confirmed ? '' : '<span class="pill">belum dikonfirmasi</span>'}</div><div>Bergabung: ${fmtDT(u.created_at)}</div><div>Login terakhir: ${fmtDT(d.last_sign_in_at)}</div><div>Role: ${esc(u.role)} · Status: ${u.is_suspended ? 'Dinonaktifkan' : 'Aktif'}</div><div>Terverifikasi: ${u.is_verified ? 'Ya (' + fmtDT(u.verified_at) + ')' : 'Belum'}</div><div>Badge: ${['verified', 'creator', 'business', 'official'].filter((k) => u['is_' + k]).concat(u.premium_until && new Date(u.premium_until) > Date.now() ? ['premium (s.d. ' + fmtDT(u.premium_until) + ')'] : []).join(', ') || 'Tidak ada'}</div><div>Laporan terhadap pengguna ini: ${d.reports_against}</div></div>
    <div class="field"><label for="vn">Catatan internal (opsional, masuk audit log)</label><input class="inp" id="vn" maxlength="200"></div>
    <div class="card sm col" style="gap:8px;margin:0 0 12px"><b>ORVIX Premium (pembayaran manual)</b><span class="dim">${u.premium_until && new Date(u.premium_until) > Date.now() ? 'Aktif sampai ' + fmtDT(u.premium_until) : 'Tidak aktif'}</span><div class="row gap" style="flex-wrap:wrap"><input class="inp" id="pd" type="number" min="1" max="1825" value="30" inputmode="numeric" style="width:96px" aria-label="Durasi hari"><span class="dim">hari</span>${[30, 90, 180, 365].map((d) => `<button type="button" class="chip" data-pd="${d}">${d}h</button>`).join('')}</div><div class="row gap" style="flex-wrap:wrap"><button class="btn primary" id="aPg">${u.premium_until && new Date(u.premium_until) > Date.now() ? 'Perpanjang Premium' : 'Aktifkan Premium'}</button><button class="btn danger" id="aPr">Cabut Premium</button></div></div>
    <div class="row gap" style="flex-wrap:wrap"><button class="btn" id="aC">${u.is_creator ? 'Cabut Creator' : 'Beri Creator'}</button><button class="btn" id="aB">${u.is_business ? 'Cabut Business' : 'Beri Business'}</button><button class="btn" id="aO" title="Khusus admin utama">${u.is_official ? 'Cabut Official' : 'Beri Official'}</button><button class="btn primary" id="aV">${verifiedBadge(16)} ${u.is_verified ? 'Cabut centang biru' : 'Beri centang biru'}</button>${u.role === 'admin' ? '' : `<button class="btn" id="aS">${icon('ban', 18)} ${u.is_suspended ? 'Aktifkan kembali' : 'Nonaktifkan'}</button>`}${self ? '' : `<button class="btn danger" id="aD">${icon('trash', 18)} Hapus pengguna</button>`}</div>`;
    const act = async (btn, fn, okMsg) => { setBusy(btn, true); try { await fn(); toast(okMsg, 'success'); fetchUsers(); await draw(); } catch (e) { setBusy(btn, false); toast(errMsg(e), 'error'); } };
    $('#aV', m.el).onclick = (e) => act(e.currentTarget, () => api('set_verified', { user_id: id, value: !u.is_verified, note: $('#vn', m.el).value }), u.is_verified ? 'Centang biru dicabut' : 'Centang biru diberikan');
    const setB = (btn, badge, on) => { const note = $('#vn', m.el).value.trim(); if (!on && !note) return toast('Isi catatan sebagai alasan pencabutan', 'error'); act(btn, async () => { const { error } = await sb.rpc('orvix_admin_set_badge', { p_user: id, p_badge: badge, p_value: on, p_reason: note || null }); if (error) throw error; }, on ? 'Badge diberikan' : 'Badge dicabut'); };
    $$('[data-pd]', m.el).forEach((b) => b.onclick = () => { $('#pd', m.el).value = b.dataset.pd; });
    $('#aPg', m.el).onclick = (e) => { const days = parseInt($('#pd', m.el).value, 10); if (!(days >= 1 && days <= 1825)) return toast('Durasi 1 sampai 1825 hari', 'error'); act(e.currentTarget, async () => { const { error } = await sb.rpc('orvix_admin_grant_premium', { p_user: id, p_days: days, p_note: $('#vn', m.el).value.trim() || null }); if (error) throw error; }, `Premium aktif ${days} hari`); };
    $('#aPr', m.el).onclick = (e) => { const note = $('#vn', m.el).value.trim(); if (!note) return toast('Isi catatan sebagai alasan pencabutan', 'error'); act(e.currentTarget, async () => { const { error } = await sb.rpc('orvix_admin_revoke_premium', { p_user: id, p_note: note }); if (error) throw error; }, 'Premium dicabut'); };
    $('#aC', m.el).onclick = (e) => setB(e.currentTarget, 'creator', !u.is_creator); $('#aB', m.el).onclick = (e) => setB(e.currentTarget, 'business', !u.is_business); $('#aO', m.el).onclick = (e) => { if (!isSuper) return toast('Badge Official hanya untuk admin utama. Jika kamu pemilik ORVIX, jalankan sql-parts/12j-admin-utama.sql.', 'error'); setB(e.currentTarget, 'official', !u.is_official); };
    if ($('#aS', m.el)) $('#aS', m.el).onclick = async (e) => { const b = e.currentTarget; if (!u.is_suspended && !(await confirmDialog({ title: `Nonaktifkan @${u.username}?`, message: 'Pengguna tidak bisa login atau mengirim pesan sampai diaktifkan kembali.', confirmText: 'Nonaktifkan', danger: true }))) return; act(b, () => api('set_suspended', { user_id: id, value: !u.is_suspended }), u.is_suspended ? 'Akun diaktifkan' : 'Akun dinonaktifkan'); };
    if ($('#aD', m.el)) $('#aD', m.el).onclick = () => deleteModal(u, m);
  };
  draw().catch((e) => { m.el.innerHTML = `<p class="err">${esc(errMsg(e))}</p>`; });
}
function deleteModal(u, parent) {
  const m = openModal({ title: 'Hapus pengguna', html: `<div class="alert warn" style="margin-bottom:14px">Menghapus <b>@${esc(u.username)}</b> (ID ${esc(u.orvix_id)}) bersifat permanen: akun, profil, pesan, story, pertemanan, dan berkas fotonya ikut terhapus. Catatan audit tetap tersimpan.</div><div class="field"><label for="cu">Ketik username <b>${esc(u.username)}</b> untuk konfirmasi</label><input class="inp" id="cu" autocomplete="off" autocapitalize="none"></div><p class="err" id="er"></p><button class="btn danger block" id="go" disabled>Hapus permanen</button>` });
  const cu = $('#cu', m.el), go2 = $('#go', m.el); cu.oninput = () => { go2.disabled = cu.value !== u.username; };
  go2.onclick = async () => { setBusy(go2, true, 'Menghapus…'); try { await api('delete_user', { user_id: u.id, confirm_username: cu.value }); toast('Pengguna dihapus', 'success'); m.close(); parent.close(); fetchUsers(); } catch (e) { setBusy(go2, false); $('#er', m.el).textContent = errMsg(e); } };
}

const STAT = { open: 'Baru', reviewing: 'Ditinjau', need_info: 'Butuh informasi', resolved: 'Selesai', dismissed: 'Ditolak' };
const REASON = { spam: 'Spam', scam: 'Penipuan', doxxing: 'Doxxing / informasi pribadi', abuse: 'Pelecehan / perundungan', threat: 'Ancaman', inappropriate: 'Konten tidak pantas', impersonation: 'Akun palsu / penyamaran', other: 'Lainnya' };
const RACT = { review: 'Tinjau', need_info: 'Minta informasi', resolve: 'Selesai', dismiss: 'Tolak', warn: 'Beri peringatan', suspend: 'Tangguhkan akun', unsuspend: 'Aktifkan akun' };
const rpc = async (fn, args) => { const { data, error } = await sb.rpc(fn, args); if (error) throw new Error(/Could not find the function|schema cache/i.test(error.message) ? 'Fungsi belum terpasang. Jalankan sql-parts/12e dan 12f di Supabase SQL Editor.' : errMsg(error)); return data; };
async function reports() {
  main.innerHTML = `<h1 style="margin-bottom:14px">Laporan</h1><div class="row gap" style="margin-bottom:14px"><select class="inp" id="rf" aria-label="Filter status" style="width:auto"><option value="">Semua status</option>${Object.entries(STAT).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div><div id="rl"><p class="dim">Memuat…</p></div>`;
  $('#rf').value = state.rf || ''; $('#rf').onchange = (e) => { state.rf = e.target.value; state.page = 0; reports().catch(fail); };
  const r = await rpc('orvix_admin_reports', { p_status: state.rf || null, p_page: state.page }), pages = Math.max(1, Math.ceil(r.total / r.pageSize));
  $('#rl').innerHTML = (r.reports.length ? `<div class="tbl">${r.reports.map((x) => `<div class="tr" style="flex-wrap:wrap"><span class="grow" style="min-width:240px"><b>${esc(REASON[x.reason] || x.reason)}</b> · <span class="pill ${x.status === 'open' ? 'bad' : ''}">${STAT[x.status] || x.status}</span><br><span class="sm">Terlapor: <b>${esc(x.reported?.display_name || '-')}</b> (@${esc(x.reported?.username || '-')})${x.reported?.is_suspended ? ' <span class="pill bad">ditangguhkan</span>' : ''} · ${x.total_against} laporan total<br>Pelapor: @${esc(x.reporter?.username || '-')}</span>${x.details ? `<br><span class="muted sm">${esc(x.details)}</span>` : ''}${x.message_snapshot ? `<br><span class="evid">Bukti pesan: “${esc(x.message_snapshot)}”</span>` : ''}<br><span class="dim">${fmtDT(x.created_at)}</span>${x.history?.length ? `<details style="margin-top:6px"><summary class="dim">Riwayat tindakan (${x.history.length})</summary>${x.history.map((h) => `<div class="dim">${fmtDT(h.at)} · ${esc(RACT[h.action] || h.action)} oleh @${esc(h.admin || '?')}${h.note ? ' — ' + esc(h.note) : ''}</div>`).join('')}</details>` : ''}</span><button class="btn sm primary" data-rep="${x.id}">Tindakan</button>${x.reported ? `<button class="btn sm" data-ru="${x.reported_user_id}">Pengguna</button>` : ''}</div>`).join('')}</div>` : '<div class="empty card"><p>Tidak ada laporan.</p></div>') + pager(pages);
  const map = new Map(r.reports.map((x) => [x.id, x]));
  $$('[data-rep]').forEach((b) => b.onclick = () => reportModal(map.get(b.dataset.rep)));
  $$('[data-ru]').forEach((b) => b.onclick = () => userModal(b.dataset.ru)); wirePager(reports);
}
const pager = (pages) => `<div class="row between" style="margin-top:14px"><span class="dim">Halaman ${state.page + 1}/${pages}</span><span class="row gap"><button class="btn sm" id="pgp" ${state.page === 0 ? 'disabled' : ''}>Sebelumnya</button><button class="btn sm" id="pgn" ${state.page + 1 >= pages ? 'disabled' : ''}>Berikutnya</button></span></div>`;
const wirePager = (fn) => { $('#pgp').onclick = () => { state.page--; fn().catch(fail); }; $('#pgn').onclick = () => { state.page++; fn().catch(fail); }; };
function reportModal(x) {
  const t = x.reported || {}, acts = ['review', 'need_info', 'warn', 'resolve', 'dismiss', ...(t.role === 'admin' ? [] : [t.is_suspended ? 'unsuspend' : 'suspend'])];
  const m = openModal({ title: 'Tindak laporan', wide: true, html: `<p class="muted" style="margin-bottom:10px">${esc(REASON[x.reason])} terhadap <b>@${esc(t.username || '-')}</b>. Satu laporan tidak otomatis menangguhkan akun; periksa bukti dulu.</p><div class="field"><label for="rn">Catatan / alasan (wajib untuk peringatan, tolak, minta info, tangguhkan; masuk audit log)</label><textarea class="inp" id="rn" maxlength="500"></textarea></div><p class="err" id="er"></p><div class="row gap" style="flex-wrap:wrap">${acts.map((a) => `<button class="btn ${a === 'suspend' ? 'danger' : a === 'resolve' ? 'primary' : ''}" data-a="${a}">${RACT[a]}</button>`).join('')}</div>` });
  m.el.onclick = async (e) => {
    const b = e.target.closest('[data-a]'); if (!b) return; const a = b.dataset.a;
    if (a === 'suspend' && !(await confirmDialog({ title: `Tangguhkan @${t.username}?`, message: 'Pengguna tidak bisa login atau mengirim pesan sampai diaktifkan kembali.', confirmText: 'Tangguhkan', danger: true }))) return;
    setBusy(b, true); try { await rpc('orvix_admin_report_action', { p_id: x.id, p_action: a, p_note: $('#rn', m.el).value }); toast('Tindakan dicatat', 'success'); m.close(); reports().catch(fail); } catch (er) { setBusy(b, false); $('#er', m.el).textContent = er.message; }
  };
}

const VST = { pending: 'Menunggu', approved: 'Disetujui', rejected: 'Ditolak', need_info: 'Perlu informasi', revoked: 'Dicabut', superseded: 'Diganti', verified: 'Terverifikasi' };
const VCAT = { konten: 'Kreator konten', seni_musik: 'Seniman / musisi', jurnalis_penulis: 'Jurnalis / penulis', toko_bisnis: 'Toko / bisnis', merek: 'Merek', organisasi: 'Organisasi', lainnya: 'Lainnya' };
async function verif() {
  main.innerHTML = `<h1 style="margin-bottom:14px">Verifikasi</h1><div class="row gap" style="margin-bottom:14px"><select class="inp" id="vf" aria-label="Filter status" style="width:auto">${['pending', 'need_info', 'approved', 'rejected', 'revoked', 'verified'].map((k) => `<option value="${k}">${k === 'verified' ? 'Semua akun terverifikasi' : VST[k]}</option>`).join('')}</select></div><div id="vl"><p class="dim">Memuat…</p></div>`;
  const cur = state.vf || 'pending'; $('#vf').value = cur; $('#vf').onchange = (e) => { state.vf = e.target.value; state.page = 0; verif().catch(fail); };
  const r = await rpc('orvix_admin_verifications', { p_status: cur, p_page: state.page }), pages = Math.max(1, Math.ceil(r.total / r.pageSize));
  if (cur === 'verified') {
    $('#vl').innerHTML = (r.verified.length ? `<div class="tbl">${r.verified.map((u) => `<div class="tr"><span class="grow"><b>${esc(u.display_name)}</b> ${verifiedBadge(14)}<br><span class="dim">@${esc(u.username)} · ID ${esc(u.orvix_id)} · sejak ${fmtDT(u.verified_at)}</span></span><button class="btn sm danger" data-rv="${u.user_id}" data-n="${esc(u.username)}">Cabut</button></div>`).join('')}</div>` : '<div class="empty card"><p>Belum ada akun terverifikasi.</p></div>') + pager(pages);
    $$('[data-rv]').forEach((b) => b.onclick = async () => { if (!(await confirmDialog({ title: `Cabut verifikasi @${b.dataset.n}?`, message: 'Lencana hilang dari profil, chat, dan story.', confirmText: 'Cabut', danger: true }))) return; setBusy(b, true); try { await rpc('orvix_admin_revoke_verification', { p_user: b.dataset.rv, p_note: null }); toast('Verifikasi dicabut', 'success'); verif().catch(fail); } catch (e) { setBusy(b, false); toast(e.message, 'error'); } });
    return wirePager(verif);
  }
  $('#vl').innerHTML = (r.requests.length ? `<div class="tbl">${r.requests.map((v) => `<div class="tr"><span class="grow"><b>${esc(v.profile.display_name)}</b> (@${esc(v.profile.username)}) · <span class="pill">${VST[v.status]}</span><br><span class="sm">${{ verified: 'Verified', creator: 'Creator', business: 'Business' }[v.kind] || v.kind} · ${VCAT[v.category] || v.category} · ${v.reports_against} laporan terhadap akun</span><br><span class="dim">${fmtDT(v.created_at)}</span></span><button class="btn sm primary" data-vq="${v.id}">Tinjau</button></div>`).join('')}</div>` : '<div class="empty card"><p>Tidak ada pengajuan.</p></div>') + pager(pages);
  const map = new Map(r.requests.map((v) => [v.id, v])); $$('[data-vq]').forEach((b) => b.onclick = () => verifModal(map.get(b.dataset.vq))); wirePager(verif);
}
async function verifModal(v) {
  const m = openModal({ title: 'Tinjau pengajuan', wide: true, html: `<div class="card sm col" style="gap:6px;margin-bottom:12px"><div><b>${esc(v.profile.display_name)}</b> @${esc(v.profile.username)} · ID ${esc(v.profile.orvix_id)}</div><div>${{ verified: 'Verified', creator: 'Creator', business: 'Business' }[v.kind] || v.kind} · ${VCAT[v.category] || v.category}</div><div style="white-space:pre-wrap">${esc(v.description)}</div>${v.links.length ? `<div>Tautan: ${v.links.map((l) => `<a href="${esc(l)}" target="_blank" rel="noopener noreferrer nofollow">${esc(l)}</a>`).join(' · ')}</div>` : ''}<div id="ev" class="dim">Memuat bukti…</div></div>${['pending', 'need_info'].includes(v.status) ? `<div class="field"><label for="vn">Alasan (wajib untuk tolak / minta informasi; dilihat pemohon)</label><textarea class="inp" id="vn" maxlength="500"></textarea></div><p class="err" id="er"></p><div class="row gap" style="flex-wrap:wrap"><button class="btn primary" data-d="approve">Setujui</button><button class="btn" data-d="need_info">Minta informasi</button><button class="btn danger" data-d="reject">Tolak</button></div>` : `<p class="dim">Status: ${VST[v.status]}${v.reject_reason ? ' · ' + esc(v.reject_reason) : ''}</p>`}` });
  sb.storage.from('verification-docs').createSignedUrls(v.evidence_paths, 600).then(({ data }) => { const el = $('#ev', m.el); if (!el) return; el.innerHTML = 'Bukti (tautan berlaku 10 menit): ' + (data || []).map((d, i) => d.signedUrl ? `<a href="${esc(d.signedUrl)}" target="_blank" rel="noopener noreferrer">Berkas ${i + 1}</a>` : '').join(' · '); });
  m.el.onclick = async (e) => {
    const b = e.target.closest('[data-d]'); if (!b) return; setBusy(b, true);
    try { await rpc('orvix_admin_review_verification', { p_id: v.id, p_decision: b.dataset.d, p_reason: $('#vn', m.el).value }); toast('Keputusan disimpan', 'success'); m.close(); verif().catch(fail); } catch (er) { setBusy(b, false); $('#er', m.el).textContent = er.message; }
  };
}
const ACT = { report_review: 'Laporan: tinjau', report_need_info: 'Laporan: minta informasi', report_resolve: 'Laporan: selesai', report_dismiss: 'Laporan: ditolak', report_warn: 'Laporan: peringatan', report_suspend: 'Laporan: tangguhkan akun', report_unsuspend: 'Laporan: aktifkan akun', verification_approve: 'Verifikasi: disetujui', verification_reject: 'Verifikasi: ditolak', verification_need_info: 'Verifikasi: minta informasi', verification_revoke: 'Verifikasi: dicabut', verify: 'Beri centang biru', unverify: 'Cabut centang biru', suspend: 'Nonaktifkan akun', unsuspend: 'Aktifkan akun', delete_user: 'Hapus pengguna', review_report: 'Tinjau laporan', self_delete: 'Pengguna hapus akun sendiri' };
async function audit() {
  main.innerHTML = '<h1 style="margin-bottom:14px">Audit log</h1><div id="al"><p class="dim">Memuat…</p></div>';
  const r = await api('list_audit', { page: state.page }), pages = Math.max(1, Math.ceil(r.total / 30));
  $('#al').innerHTML = (r.logs.length ? `<div class="tbl">${r.logs.map((l) => `<div class="tr"><span class="grow"><b>${esc(ACT[l.action] || l.action)}</b><br><span class="dim">oleh @${esc(l.admin_username || 'sistem')} · ${fmtDT(l.created_at)}${l.details?.username ? ' · target @' + esc(l.details.username) : ''}${l.details?.note ? ' · catatan: ' + esc(l.details.note) : ''}</span></span></div>`).join('')}</div>` : '<div class="empty card"><p>Belum ada catatan.</p></div>') + `<div class="row between" style="margin-top:14px"><span class="dim">Halaman ${state.page + 1}/${pages}</span><span class="row gap"><button class="btn sm" id="ap" ${state.page === 0 ? 'disabled' : ''}>Sebelumnya</button><button class="btn sm" id="an" ${state.page + 1 >= pages ? 'disabled' : ''}>Berikutnya</button></span></div>`;
  $('#ap').onclick = () => { state.page--; audit().catch(fail); }; $('#an').onclick = () => { state.page++; audit().catch(fail); };
}
drawSide(); go();
