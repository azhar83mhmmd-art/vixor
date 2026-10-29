// Komponen popup profil TUNGGAL (bottom sheet di HP, modal di desktop). Dipakai oleh: ID di pesan, avatar/nama di chat,
// anggota grup, hasil cari, daftar kontak. Semua data lewat RPC aman (orvix_lookup_profile / orvix_profile_card).
import { sb, errMsg } from './supabase.js';
import { $, esc, icon, avatar, badgesHtml, toast, setBusy, copyText, relTime } from './utils.js';
import { startCall, activeSession, callsAvailable } from './calls-core.js';

let deps = { me: null, startChat: null, showConv: null, openFull: null, report: null, addFriend: null };
export const initProfileCards = (d) => { deps = { ...deps, ...d }; };

/* ---------- deteksi ID di teks pesan ---------- */
// 8 angka berdiri sendiri, atau @username. Dilewati: URL, email, teks dalam `kode`, angka yang menempel pada angka/titik/koma/tanda hubung/+/ (nomor telepon, harga, tanggal).
const SKIP = /(`[^`]*`|https?:\/\/\S+|www\.\S+|[\w.+-]+@[\w-]+\.[\w.-]+)/gi;
const ID_RE = /(^|[^\w@.,+\-/:#])(@[a-z0-9_]{3,20}|\d{8})(?![\w\-/:%]|[.,]\d)/gi;   // dipakai lewat new RegExp(ID_RE) agar lastIndex tidak bocor
export function linkifyIds(text) {
  const raw = String(text ?? '');
  if (!/\d{8}|@[a-z0-9_]{3,20}/i.test(raw)) return esc(raw);       // jalur cepat: sebagian besar pesan tidak mengandung ID
  let out = '', last = 0, m;
  const plain = (s) => esc(s).replace(new RegExp(ID_RE), (all, pre, id) => `${pre}<button type="button" class="idlink" data-orvix-q="${esc(id)}" aria-label="Lihat profil ${esc(id)}">${esc(id)}</button>`);
  SKIP.lastIndex = 0;
  while ((m = SKIP.exec(raw))) { out += plain(raw.slice(last, m.index)) + esc(m[0]); last = m.index + m[0].length; }
  return out + plain(raw.slice(last));
}

/* ---------- popup ---------- */
let cur = null;
const lastSeen = (t) => (Date.now() - new Date(t) < 120000 ? 'Online' : 'Terakhir aktif ' + relTime(t));
const relLabel = { friend: 'Teman', pending_out: 'Permintaan terkirim', pending_in: 'Mengajak berteman' };

export function openProfileCard(src) {          // src: { q: '12345678' | '@user' } atau { userId }
  cur?.close(true);
  const prev = document.activeElement;
  const back = document.createElement('div'); back.className = 'pc-back';
  back.innerHTML = `<div class="pc" role="dialog" aria-modal="true" aria-label="Profil pengguna" tabindex="-1"><div class="pc-grab" aria-hidden="true"><i></i></div><div class="pc-body"></div></div>`;
  document.body.append(back); document.body.classList.add('noscroll');
  const sheet = $('.pc', back), body = $('.pc-body', back);
  let gone = false, data = null;
  requestAnimationFrame(() => back.classList.add('in'));
  history.pushState({ pc: 1 }, '');
  const remove = (silent) => {
    if (gone) return; gone = true; removeEventListener('popstate', onPop); document.removeEventListener('keydown', onKey); cur = null;
    back.classList.remove('in'); back.classList.add('out');
    setTimeout(() => { back.remove(); if (!document.querySelector('.modal-back,.pscreen,.pc-back')) document.body.classList.remove('noscroll'); if (!silent) prev?.focus?.({ preventScroll: true }); }, silent ? 0 : 200);
  };
  const close = (silent) => { if (gone) return; if (history.state?.pc && !silent) history.back(); else remove(silent); };
  // Tutup dulu (history.back) lalu jalankan aksi setelah popstate, supaya tumpukan riwayat tombol Kembali tetap rapi.
  const closeThen = (fn) => { if (gone) return fn(); const run = () => setTimeout(fn, 40); if (history.state?.pc) { addEventListener('popstate', run, { once: true }); history.back(); } else { remove(); run(); } };
  const onPop = () => remove(); addEventListener('popstate', onPop);
  const onKey = (e) => {
    if (e.key === 'Escape' && !document.querySelector('.modal-back')) return close();
    if (e.key === 'Tab') { const f = [...sheet.querySelectorAll('button:not([disabled]),a[href],[tabindex="0"]')].filter((x) => x.offsetParent); if (!f.length) return; const a = f[0], z = f[f.length - 1]; if (e.shiftKey && document.activeElement === a) { z.focus(); e.preventDefault(); } else if (!e.shiftKey && document.activeElement === z) { a.focus(); e.preventDefault(); } }
  };
  document.addEventListener('keydown', onKey);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  bindSwipe(sheet, back, () => close());
  cur = { close };

  const skeleton = () => { body.innerHTML = `<div class="pc-cover sk"></div><div class="pc-main"><div class="sk sk-av"></div><div class="sk sk-l1"></div><div class="sk sk-l2"></div><div class="pc-acts"><i class="sk"></i><i class="sk"></i><i class="sk"></i></div></div>`; };
  const failView = (title, msg, retry) => {
    body.innerHTML = `<div class="pc-empty"><button class="ibtn pc-x" data-close aria-label="Tutup">${icon('x', 20)}</button><span class="pc-ei">${icon('user', 30)}</span><h3>${esc(title)}</h3>${msg ? `<p class="dim">${esc(msg)}</p>` : ''}${retry ? '<button class="btn" data-retry>Coba lagi</button>' : '<button class="btn ghost" data-close>Tutup</button>'}</div>`;
    $('[data-retry]', body)?.addEventListener('click', load); body.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => close()));
    (body.querySelector('button.btn') || sheet).focus();
  };

  async function load() {
    skeleton();
    try {
      const { data: rows, error } = src.userId ? await sb.rpc('orvix_profile_card', { target: src.userId }) : await sb.rpc('orvix_lookup_profile', { q: src.q });
      if (gone) return;
      if (error) { if (/Terlalu banyak/i.test(error.message || '')) return failView('Terlalu banyak pencarian', 'Tunggu sebentar lalu coba lagi.', true); throw error; }
      const u = rows?.[0];
      if (!u) return failView('Pengguna ORVIX tidak ditemukan.', '', false);     // pesan sama untuk: tidak ada, diblokir, dinonaktifkan
      data = u; render();
    } catch (e) {
      if (gone) return;
      const off = !navigator.onLine || /fetch|network|Failed/i.test(String(e?.message || e));
      failView(off ? 'Tidak ada koneksi' : 'Gagal memuat profil', off ? 'Periksa jaringanmu lalu coba lagi.' : errMsg(e), true);
    }
  }

  function render() {
    const u = data, self = u.relation === 'self', canMsg = !self && u.can_message, callOk = callsAvailable();
    const seen = u.last_seen_at ? lastSeen(u.last_seen_at) : '';
    const note = self ? 'Ini akunmu.' : !u.can_message ? 'Pengguna ini hanya menerima chat dari teman.' : !callOk ? 'Panggilan belum aktif di server ini.' : '';
    body.innerHTML = `<div class="pc-cover ${u.banner_url ? 'has' : ''}">${u.banner_url ? `<img src="${esc(u.banner_url)}" alt="" decoding="async" onerror="this.remove()">` : `<div class="pc-bg" ${u.avatar_url ? `style="background-image:url('${esc(u.avatar_url)}')"` : ''}></div>`}
        <button class="ibtn pc-x" data-close aria-label="Tutup">${icon('x', 20)}</button><button class="ibtn pc-more" data-more aria-haspopup="menu" aria-expanded="false" aria-label="Opsi lainnya">${icon('more', 20)}</button></div>
      <div class="pc-main"><div class="pc-av">${avatar(u.display_name, u.avatar_url, 92)}</div>
        <h2 class="pc-name">${esc(u.display_name)} <span class="pc-badges">${badgesHtml(u, 18, true)}</span></h2>
        <p class="pc-user">@${esc(u.username)}</p>
        <div class="pc-chips">${seen ? `<span class="chip ${seen === 'Online' ? 'live' : ''}"><i></i>${esc(seen)}</span>` : ''}<button class="chip" data-copy aria-label="Salin ID ORVIX">ID ${esc(u.orvix_id)} ${icon('copy', 14)}</button>${relLabel[u.relation] ? `<span class="chip">${relLabel[u.relation]}</span>` : ''}</div>
        <p class="pc-bio ${u.bio ? '' : 'dim'}">${esc(u.bio || 'Belum ada info')}</p>
        <div class="pc-acts">
          <button class="pa" data-chat ${canMsg ? '' : 'disabled'}><span>${icon('chat', 22)}</span><small>Kirim pesan</small></button>
          <button class="pa" data-call ${canMsg && callOk ? '' : 'disabled'} aria-haspopup="true"><span>${icon('phone', 22)}</span><small>Telepon</small></button>
          <button class="pa" data-full><span>${icon('user', 22)}</span><small>Lihat profil</small></button>
        </div>
        <div class="pc-callpick hide" role="group" aria-label="Jenis panggilan"><button class="btn" data-k="voice">${icon('phone', 18)} Suara</button><button class="btn" data-k="video">${icon('video', 18)} Video</button></div>
        ${note ? `<p class="pc-note">${esc(note)}</p>` : ''}
        ${!self && !u.can_message && u.relation === 'none' && deps.addFriend ? '<button class="btn primary block" data-friend style="margin-top:10px">Tambah teman</button>' : ''}
        <div class="pc-menu hide" role="menu">
          <button role="menuitem" data-copy2>${icon('copy', 18)} Salin ID ORVIX</button><button role="menuitem" data-share>${icon('share', 18)} Bagikan profil</button>
          ${self ? '' : `<button role="menuitem" data-rep class="danger">${icon('flag', 18)} Laporkan pengguna</button>`}</div>
      </div>`;
    wire(); ($('.pc-acts button:not([disabled])', body) || sheet).focus();
  }

  function wire() {
    const u = data, q = (s) => $(s, body), menu = q('.pc-menu'), pick = q('.pc-callpick');
    q('[data-close]').onclick = () => close();
    q('[data-copy]').onclick = () => copyText(u.orvix_id);
    q('[data-more]').onclick = (e) => { const open = menu.classList.toggle('hide') === false; e.currentTarget.setAttribute('aria-expanded', String(open)); };
    q('[data-copy2]').onclick = () => { menu.classList.add('hide'); copyText(u.orvix_id); };
    q('[data-share]').onclick = async () => {
      menu.classList.add('hide'); const text = `${u.display_name} di ORVIX — @${u.username} (ID ${u.orvix_id})`;
      try { if (navigator.share) await navigator.share({ title: 'Profil ORVIX', text }); else copyText(text); } catch { /* batal */ }
    };
    q('[data-rep]')?.addEventListener('click', () => { menu.classList.add('hide'); if (deps.report) closeThen(() => deps.report(u.id, u.display_name)); else toast('Pelaporan belum tersedia di halaman ini.', 'error'); });
    q('[data-full]').onclick = () => { if (!deps.openFull) return; const d = { ...u }; closeThen(() => deps.openFull(d)); };
    q('[data-friend]')?.addEventListener('click', async (e) => { setBusy(e.currentTarget, true); try { await deps.addFriend(u.id); toast('Permintaan terkirim', 'success'); data.relation = 'pending_out'; render(); } catch (x) { setBusy(e.currentTarget, false); toast(errMsg(x), 'error'); } });
    q('[data-chat]').onclick = async (e) => {
      const b = e.currentTarget; if (b.disabled || !deps.startChat) return; b.disabled = true; b.classList.add('busy');
      try { const cid = await deps.startChat(u.id); closeThen(() => deps.showConv(cid, u.id)); } catch (x) { b.disabled = false; b.classList.remove('busy'); toast(errMsg(x), 'error'); }     // start_direct_chat (server): satu chat per pasangan, menolak diri sendiri, blokir, dan akun nonaktif
    };
    q('[data-call]').onclick = () => { if (q('[data-call]').disabled) return; pick.classList.toggle('hide'); };
    pick.onclick = async (e) => {
      const b = e.target.closest('[data-k]'); if (!b) return;
      if (activeSession()) return toast('Kamu masih dalam panggilan.', 'error');
      setBusy(b, true);
      try {
        const cid = await deps.startChat(u.id);      // validasi server: blokir, nonaktif, izin chat
        const kind = b.dataset.k; closeThen(async () => { try { await deps.showConv(cid, u.id); await startCall(cid, kind, { isGroup: false, title: u.display_name, avatar: u.avatar_url, otherId: u.id }); } catch (x) { if (!x?.shown) toast(x?.message ? errMsg(x) : 'Tidak bisa memulai panggilan.', 'error'); } });
      } catch (x) { setBusy(b, false); if (!x?.shown) toast(x?.message ? errMsg(x) : 'Tidak bisa memulai panggilan.', 'error'); }
    };
  }
  load();
  return { close };
}

/* ---------- swipe-down untuk menutup (HP) ---------- */
function bindSwipe(sheet, back, onClose) {
  let y0 = null, dy = 0, drag = false;
  const ok = (e) => matchMedia('(max-width:640px)').matches && (e.target.closest('.pc-grab,.pc-cover') || sheet.scrollTop <= 0);
  sheet.addEventListener('touchstart', (e) => { if (e.touches.length !== 1 || !ok(e)) { y0 = null; return; } y0 = e.touches[0].clientY; dy = 0; drag = false; }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (y0 == null) return; dy = e.touches[0].clientY - y0;
    if (dy > 8) { drag = true; sheet.style.transition = 'none'; sheet.style.transform = `translateY(${dy}px)`; back.style.setProperty('--pc-dim', String(Math.max(0, 1 - dy / 400))); }
  }, { passive: true });
  const end = () => { if (y0 == null) return; y0 = null; sheet.style.transition = ''; if (drag && dy > 110) onClose(); else { sheet.style.transform = ''; back.style.removeProperty('--pc-dim'); } drag = false; };
  sheet.addEventListener('touchend', end); sheet.addEventListener('touchcancel', end);
}

/* ---------- pemasangan klik (delegasi) ---------- */
// Elemen apa pun dengan data-orvix-q="12345678|@user" atau data-pc-user="<uuid>" membuka popup yang sama.
export function bindProfileTriggers(root = document) {
  if (root.__pcBound) return; root.__pcBound = true;
  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-orvix-q],[data-pc-user]'); if (!t || t.closest('.msg[role="checkbox"]')) return;   // saat memilih pesan, ketuk = pilih/lepas
    e.preventDefault(); e.stopPropagation();
    openProfileCard(t.dataset.pcUser ? { userId: t.dataset.pcUser } : { q: t.dataset.orvixQ });
  }, true);
  root.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-pc-user][tabindex]')) { e.preventDefault(); e.target.click(); } });
}
