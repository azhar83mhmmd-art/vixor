// Pesan lanjutan Premium: pesan terjadwal, draft per percakapan, pencarian lanjutan.
// Semua aturan (Premium, izin kirim, batas) divalidasi di database (sql-parts/16a-pesan-lanjutan.sql); UI hanya menampilkan hasilnya.
import { sb, errMsg } from './supabase.js';
import { $, esc, icon, toast, setBusy, openModal, confirmDialog, relTime, isPremium } from './utils.js';

const DB_FILE = '16a-pesan-lanjutan.sql';
const dbErr = (e) => (/could not find the function|does not exist|schema cache|42883|42P01/i.test(errMsg(e)) ? `Fitur belum aktif di database. Jalankan sql-parts/${DB_FILE} di SQL Editor Supabase, lalu muat ulang halaman.` : errMsg(e));
const fmtDT = (d) => new Intl.DateTimeFormat('id-ID', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(d)).replace(/\./g, ':');
const toLocalInput = (d) => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
const inTxt = (d) => { const m = Math.max(1, Math.round((new Date(d) - Date.now()) / 60000)); return m < 60 ? `dalam ${m} menit` : m < 1440 ? `dalam ${Math.round(m / 60)} jam` : `dalam ${Math.round(m / 1440)} hari`; };

export function premiumInfo(what) {
  openModal({ title: 'Fitur ORVIX Premium', sheet: true, html: `<div class="col"><div class="alert info"><b>${esc(what)}</b> khusus pengguna ORVIX Premium. Premium diaktifkan oleh admin ORVIX; lihat detailnya di menu Premium.</div></div>` });
}

/* ================= Draft per percakapan ================= */
let drafts = null, draftsP = null;
const loadDrafts = () => (draftsP ||= (async () => {
  drafts = new Map();
  try { const { data, error } = await sb.rpc('orvix_get_drafts'); if (error) throw error; (data || []).forEach((d) => drafts.set(d.conversation_id, d.content)); } catch (e) { console.warn('[draft]', errMsg(e)); }
})());
const pushDraft = (conv, text) => sb.rpc('orvix_save_draft', { p_conv: conv, p_content: text }).then(({ error }) => { if (error) console.warn('[draft]', errMsg(error)); });

// Pulihkan draft ke kolom ketik dan simpan otomatis (debounce). Mengembalikan fungsi pelepas (flush + bersihkan listener).
export function draftBind(me, ta, conv) {
  if (!isPremium(me) || !ta) return () => {};
  let t = 0, last = null, dead = false;
  loadDrafts().then(() => {
    if (dead) return; const d = drafts.get(conv);
    if (d && !ta.value) { ta.value = d; ta.dispatchEvent(new Event('input')); }
    last = ta.value;
  });
  const flush = () => { clearTimeout(t); t = 0; if (last === null) return; const v = ta.value; if (v === last) return; last = v; drafts && (v.trim() ? drafts.set(conv, v) : drafts.delete(conv)); pushDraft(conv, v); };
  const on = () => { clearTimeout(t); t = setTimeout(flush, 900); };
  const hide = () => { if (document.hidden) flush(); };
  ta.addEventListener('input', on); ta.addEventListener('blur', flush); document.addEventListener('visibilitychange', hide); addEventListener('pagehide', flush);
  return () => { dead = true; flush(); ta.removeEventListener('input', on); ta.removeEventListener('blur', flush); document.removeEventListener('visibilitychange', hide); removeEventListener('pagehide', flush); };
}
// Dipanggil setelah pesan terkirim agar draft lama tidak muncul lagi.
export function draftClear(me, conv) {
  if (!isPremium(me)) return; if (drafts) drafts.delete(conv);
  sb.rpc('orvix_save_draft', { p_conv: conv, p_content: '' }).then(() => {}, () => {});
}

/* ================= Pesan terjadwal ================= */
const ST = { scheduled: ['Terjadwal', ''], sent: ['Terkirim', 'good'], failed: ['Gagal', 'bad'], cancelled: ['Dibatalkan', ''] };

// Buat jadwal baru, atau ubah jika `edit` diberikan ({id, content, send_at, conversation_id}).
export function openScheduleModal({ me, convId, convTitle, text = '', edit = null, onDone }) {
  if (!isPremium(me)) return premiumInfo('Pesan terjadwal');
  const min = new Date(Date.now() + 2 * 60000), init = edit ? new Date(edit.send_at) : new Date(Date.now() + 3600000);
  const chip = (id, label) => `<button type="button" class="chip-b" data-q="${id}">${label}</button>`;
  const m = openModal({ title: edit ? 'Ubah pesan terjadwal' : 'Jadwalkan pesan', sheet: true, html: `<form id="sf" novalidate class="sched">
    <p class="dim" style="margin:0 0 10px">Ke <b>${esc(convTitle || 'percakapan ini')}</b>. Dikirim otomatis oleh server, walau aplikasi sedang ditutup.</p>
    <div class="field"><label for="sc">Pesan</label><textarea class="inp" id="sc" maxlength="4000" rows="4" style="min-height:96px">${esc(edit ? edit.content : text)}</textarea><span class="hint" id="scn">0/4000</span></div>
    <div class="field"><label for="sd">Waktu kirim (zona waktumu)</label><input class="inp" id="sd" type="datetime-local" min="${toLocalInput(min)}" value="${toLocalInput(init)}"></div>
    <div class="chips" aria-label="Pilihan cepat">${chip('1h', '1 jam lagi')}${chip('eve', 'Malam ini 20:00')}${chip('mor', 'Besok 08:00')}</div>
    <p class="err" id="se" role="alert"></p>
    <button class="btn primary block lg" id="ss">${icon('clock', 18)} ${edit ? 'Simpan perubahan' : 'Jadwalkan'}</button></form>` });
  const sc = $('#sc', m.el), sd = $('#sd', m.el), cnt = () => { $('#scn', m.el).textContent = sc.value.length + '/4000'; }; cnt(); sc.oninput = cnt; setTimeout(() => sc.focus(), 60);
  m.el.querySelectorAll('[data-q]').forEach((b) => b.onclick = () => {
    const d = new Date(), k = b.dataset.q;
    if (k === '1h') d.setHours(d.getHours() + 1);
    else if (k === 'eve') { d.setHours(20, 0, 0, 0); if (d <= min) d.setDate(d.getDate() + 1); }
    else { d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); }
    sd.value = toLocalInput(d);
  });
  $('#sf', m.el).onsubmit = async (e) => {
    e.preventDefault(); const er = $('#se', m.el), btn = $('#ss', m.el); er.textContent = '';
    const content = sc.value.trim(), when = new Date(sd.value);
    if (!content) return (er.textContent = 'Tulis isi pesan.');
    if (isNaN(when) || when.getTime() < Date.now() + 30000) return (er.textContent = 'Pilih waktu di masa depan.');
    setBusy(btn, true, 'Menyimpan…');
    const { error } = edit ? await sb.rpc('orvix_update_scheduled', { p_id: edit.id, p_content: content, p_send_at: when.toISOString() }) : await sb.rpc('orvix_schedule_message', { p_conv: convId, p_content: content, p_send_at: when.toISOString() });
    if (error) { setBusy(btn, false); er.textContent = dbErr(error); return; }
    m.close(); toast(`Terjadwal untuk ${fmtDT(when)}`, 'success'); onDone && onDone();
  };
  return m;
}

export async function openScheduledList({ me, titleOf }) {
  if (!isPremium(me)) return premiumInfo('Pesan terjadwal');
  const m = openModal({ title: 'Pesan terjadwal', wide: true, html: '<div id="sl" class="col"><p class="dim">Memuat…</p></div>' });
  const box = $('#sl', m.el);
  const draw = async () => {
    const { data, error } = await sb.from('orvix_scheduled_messages').select('id,conversation_id,content,send_at,status,error,sent_at').order('send_at', { ascending: false }).limit(60);
    if (error) { box.innerHTML = `<p class="err">${esc(dbErr(error))}</p>`; return; }
    if (!data.length) { box.innerHTML = `<div class="empty" style="padding:28px 8px">${icon('clock', 36)}<p>Belum ada pesan terjadwal.</p><p class="dim">Buka percakapan, lalu pilih Jadwalkan pesan di menu atau tombol jam di kolom ketik.</p></div>`; return; }
    box.innerHTML = data.map((r) => { const [lb, cls] = ST[r.status] || [r.status, '']; const act = r.status === 'scheduled' || r.status === 'failed';
      return `<div class="card sm sl-r" data-id="${r.id}"><div class="row gap" style="align-items:flex-start"><span class="grow" style="min-width:0"><b class="ell" style="display:block">${esc(titleOf(r.conversation_id))}</b><span class="dim">${r.status === 'sent' ? 'Terkirim ' + fmtDT(r.sent_at || r.send_at) : fmtDT(r.send_at) + ' · ' + (new Date(r.send_at) > Date.now() ? inTxt(r.send_at) : relTime(r.send_at))}</span></span><span class="pill ${cls}">${lb}</span></div>
      <p class="sl-t">${esc(r.content.length > 220 ? r.content.slice(0, 220) + '…' : r.content)}</p>${r.status === 'failed' && r.error ? `<p class="err" style="min-height:0;margin:4px 0 0">${esc(r.error)}</p>` : ''}
      <div class="row gap sl-a">${act ? `<button class="btn sm" data-a="edit">${icon('edit', 16)} ${r.status === 'failed' ? 'Ubah dan jadwalkan ulang' : 'Ubah'}</button>` : ''}${r.status === 'scheduled' ? `<button class="btn sm" data-a="cancel">Batalkan</button>` : ''}${r.status !== 'scheduled' ? `<button class="btn sm danger" data-a="del">${icon('trash', 16)} Hapus</button>` : ''}</div></div>`; }).join('');
    box._rows = new Map(data.map((r) => [r.id, r]));
  };
  box.onclick = async (e) => {
    const b = e.target.closest('[data-a]'); if (!b) return; const id = b.closest('[data-id]').dataset.id, r = box._rows.get(id), a = b.dataset.a;
    if (a === 'edit') return openScheduleModal({ me, convId: r.conversation_id, convTitle: titleOf(r.conversation_id), edit: r, onDone: draw });
    if (a === 'cancel' && !(await confirmDialog({ title: 'Batalkan pesan terjadwal?', message: 'Pesan tidak akan dikirim. Kamu masih bisa mengubah dan menjadwalkannya lagi.', confirmText: 'Batalkan pesan' }))) return;
    if (a === 'del' && !(await confirmDialog({ title: 'Hapus dari daftar?', message: 'Catatan jadwal ini dihapus. Pesan yang sudah terkirim tetap ada di chat.', confirmText: 'Hapus', danger: true }))) return;
    setBusy(b, true); const { error } = await sb.rpc(a === 'del' ? 'orvix_delete_scheduled' : 'orvix_cancel_scheduled', { p_id: id });
    if (error) { setBusy(b, false); return toast(dbErr(error), 'error'); } toast(a === 'del' ? 'Dihapus' : 'Dibatalkan', 'success'); draw();
  };
  draw(); return m;
}

/* ================= Pencarian lanjutan ================= */
// ctx: { me, convId (percakapan aktif atau null), convTitle, titleOf(id), senders:[{id,name}], onOpen(convId) }
export function openSearch(ctx) {
  const { me, convId, convTitle, titleOf, senders = [], onOpen } = ctx, prem = isPremium(me);
  const m = openModal({ title: 'Cari pesan', wide: true, html: `<form id="qf" class="srch" novalidate>
    <div class="row gap"><input class="inp grow" id="qq" type="search" placeholder="Kata kunci" autocomplete="off" maxlength="100" aria-label="Kata kunci"><button class="btn primary" id="qg">${icon('search', 18)} Cari</button></div>
    <details class="sfil"><summary>Filter lanjutan ${prem ? '' : '<span class="pill">Premium</span>'}</summary><div class="sfil-g">
      <label>Di mana<select class="inp" id="qs" ${prem ? '' : 'disabled'}>${convId ? `<option value="c">${esc(convTitle || 'Chat ini')}</option>` : ''}<option value="all" ${convId ? '' : 'selected'}>Semua percakapan (90 hari)</option></select></label>
      <label>Pengirim<select class="inp" id="qp" ${prem ? '' : 'disabled'}><option value="">Siapa saja</option><option value="${me.id}">Saya</option>${senders.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
      <label>Jenis<select class="inp" id="qk" ${prem ? '' : 'disabled'}><option value="">Semua</option><option value="text">Teks</option><option value="image">Foto</option><option value="video">Video</option></select></label>
      <label>Dari tanggal<input class="inp" id="qa" type="date" ${prem ? '' : 'disabled'}></label>
      <label>Sampai tanggal<input class="inp" id="qb" type="date" ${prem ? '' : 'disabled'}></label>
      ${prem ? '' : '<p class="hint" style="grid-column:1/-1">Pengguna gratis mencari kata kunci di percakapan yang sedang dibuka. Premium membuka pencarian semua chat dan filter.</p>'}</div></details>
    <p class="err" id="qe" role="alert"></p></form><div id="qr" class="col" aria-live="polite"></div>`, onClose: () => {} });
  const qq = $('#qq', m.el), res = $('#qr', m.el); setTimeout(() => qq.focus(), 60);
  let cursor = null, term = '', busy = false;
  const params = () => {
    const where = prem ? $('#qs', m.el).value : 'c', a = $('#qa', m.el).value, b = $('#qb', m.el).value;
    const p = { p_q: qq.value.trim() || null, p_conv: where === 'all' ? null : convId, p_limit: 30, p_before: cursor };
    if (prem) { p.p_sender = $('#qp', m.el).value || null; p.p_kind = $('#qk', m.el).value || null; if (a) p.p_since = new Date(a + 'T00:00:00').toISOString(); if (b) { const e = new Date(b + 'T00:00:00'); e.setDate(e.getDate() + 1); p.p_until = e.toISOString(); } }
    return p;
  };
  const mark = (t) => { const s = esc(t.length > 240 ? t.slice(0, 240) + '…' : t); if (!term) return s; const re = new RegExp(esc(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'); return s.replace(re, (x) => `<mark>${x}</mark>`); };
  const KIND = { image: 'Foto', video: 'Video' };
  const run = async (more) => {
    if (busy) return; const er = $('#qe', m.el); er.textContent = ''; if (!more) { cursor = null; res.innerHTML = '<p class="dim">Mencari…</p>'; term = qq.value.trim(); }
    if (!convId && !prem) { er.textContent = 'Buka sebuah percakapan untuk mencari, atau gunakan Premium untuk mencari di semua chat.'; res.innerHTML = ''; return; }
    busy = true; const p = params(); if (more) p.p_before = cursor;
    const { data, error } = await sb.rpc('orvix_search_messages', p); busy = false; $('#qmore', m.el)?.remove();
    if (error) { res.innerHTML = ''; er.textContent = dbErr(error); return; }
    if (!more) res.innerHTML = '';
    if (!data.length && !more) { res.innerHTML = `<div class="empty" style="padding:24px 8px"><p>Tidak ada pesan yang cocok.</p></div>`; return; }
    res.insertAdjacentHTML('beforeend', data.map((r) => `<button type="button" class="card sm srch-r" data-c="${r.conversation_id}"><span class="row gap"><b class="ell grow">${esc(titleOf(r.conversation_id))}</b><span class="dim">${fmtDT(r.created_at)}</span></span><span class="srch-t">${KIND[r.message_type] ? `<span class="pill">${KIND[r.message_type]}</span> ` : ''}${mark(r.content || '')}</span></button>`).join(''));
    cursor = data.length ? data[data.length - 1].created_at : cursor;
    if (data.length >= 30) res.insertAdjacentHTML('beforeend', '<button type="button" class="btn block" id="qmore">Muat lebih banyak</button>');
  };
  $('#qf', m.el).onsubmit = (e) => { e.preventDefault(); run(false); };
  m.el.onclick = (e) => { if (e.target.closest('#qmore')) return run(true); const r = e.target.closest('.srch-r'); if (r) { m.close(); onOpen && onOpen(r.dataset.c); } };
  return m;
}
