// Profil, pengaturan privasi, keamanan, blokir, hapus akun.
import { sb, requireAuth, cacheMe, logout, fetchProfiles, purgeAvatarFiles, purgeBannerFiles, purgeUserFiles, errMsg } from './supabase.js';
import { cropImage } from './cropper.js';
import { openPremiumHub } from './premium.js';
import { canInstall, promptInstall, onInstallChange, isStandalone, isIOS, wasInstalled } from './pwa.js';
import { pushStatus, enablePush, disablePush, getPrefs, setPrefs, sendTest, diagnose } from './push.js';
import { $, esc, icon, avatar, nameWithBadge, toast, setBusy, openModal, confirmDialog, copyText, validateImage, extOf, mountShell, THEMES, applyTheme, currentTheme, relTime, wallpaperModal, isPremium } from './utils.js';

const { profile: me } = await requireAuth({ shell: '/profile' });
mountShell('/profile', me.role === 'admin');
const body = $('#body');
const VIS = { friends: 'Teman saya', public: 'Semua pengguna', only_me: 'Hanya saya' };
const MSGP = { friends: ['Harus berteman terlebih dahulu', 'Orang yang menemukan ID ORVIX-mu harus mengirim permintaan pertemanan dan diterima sebelum bisa chat.'], anyone: ['Izinkan chat langsung', 'Pengguna yang menemukan akunmu lewat ID ORVIX bisa langsung memulai chat tanpa berteman. Blokir tetap berlaku.'] };

const COLS = 'display_name,username,avatar_url,status_text,profile_public,show_last_seen,story_visibility,who_can_message,theme';
async function upd(fields) {
  // banner_url hanya ikut diminta bila kolomnya sudah ada (setelah sql-parts/12h dijalankan)
  const cols = 'banner_url' in fields || 'banner_url' in me ? COLS + ',banner_url' : COLS;
  const { data, error } = await sb.from('profiles').update(fields).eq('id', me.id).select(cols).single();
  if (error) throw error; Object.assign(me, data); cacheMe(me); return data;
}
const noBannerCol = (x) => /banner_url/i.test(errMsg(x)) ? new Error('Fitur banner belum aktif di database. Jalankan sql-parts/12h-banner-profil.sql di SQL Editor Supabase.') : x;
let pickKind = 'avatar', firstRender = true;
const sw = (id, on, label) => `<button class="switch" role="switch" id="${id}" aria-checked="${on}" aria-label="${label}"></button>`;

/* ---------- PWA + notifikasi push ---------- */
const sr = (id, t, sub, right = '') => `<div class="setrow" ${id ? `id="${id}"` : ''}>${icon('bell', 24)}<span class="grow"><b>${t}</b><small>${sub}</small></span>${right}</div>`;
const gd = (fn) => async (e) => { try { await fn(e); } catch (x) { toast(errMsg(x), 'error'); } };
let installBound = false;
const SVG = (d, s = 20) => `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${d}</svg>`;
const I_DL = '<path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14"/>', I_BOLT = '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>', I_APP = '<rect x="6" y="2.5" width="12" height="19" rx="3"/><path d="M10.5 18.5h3"/>', I_SHARE = '<path d="M12 15V4m0 0L8 8m4-4 4 4M6 12v7h12v-7"/>', I_DOTS = '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>';
function paintInstall() {
  const box = $('#installBox'); if (!box) return;
  if (!installBound) { installBound = true; onInstallChange(() => paintInstall()); }
  const head = (badge = '') => `<div class="inst-top"><span class="inst-ic"><img src="/assets/icon-192.png" alt="" width="56" height="56"></span><span class="grow"><b>ORVIX untuk perangkat ini</b><small>Pasang sebagai aplikasi: buka dari layar utama, tanpa bilah alamat.</small></span>${badge}</div>`;
  const pts = `<ul class="inst-pts"><li>${icon('bell', 18)}<span>Notifikasi pesan, permintaan pertemanan, dan panggilan</span></li><li>${SVG(I_BOLT, 18)}<span>Terbuka lebih cepat dari ikon di layar utama</span></li><li>${SVG(I_APP, 18)}<span>Tampil layar penuh seperti aplikasi biasa</span></li></ul>`;
  const step = (n, t) => `<li><i>${n}</i><span>${t}</span></li>`;
  let inner;
  if (isStandalone()) inner = head(`<span class="inst-ok">${icon('check', 14)} Terpasang</span>`) + `<p class="inst-note">Kamu sedang memakai ORVIX sebagai aplikasi. Aktifkan notifikasi di bawah agar tidak ketinggalan chat dan telepon.</p>`;
  else if (canInstall()) inner = head() + pts + `<button class="btn primary block lg" id="btnInstall">${SVG(I_DL, 20)} Install ORVIX</button>`;
  else if (wasInstalled()) inner = head(`<span class="inst-ok">${icon('check', 14)} Terpasang</span>`) + `<p class="inst-note">ORVIX sudah terpasang di perangkat ini. Buka lewat ikon ORVIX di layar utama atau daftar aplikasi agar notifikasi bekerja penuh.</p>`;
  else if (!isSecureContext) inner = head() + `<p class="inst-note">Pemasangan hanya tersedia lewat HTTPS. Buka ORVIX dari alamat https:// lalu coba lagi.</p>`;
  else if (isIOS()) inner = head() + pts + `<ol class="inst-steps">${step(1, `Ketuk tombol <b>Bagikan</b> ${SVG(I_SHARE, 16)} di Safari`)}${step(2, 'Pilih <b>Tambahkan ke Layar Utama</b>')}${step(3, 'Ketuk <b>Tambah</b>, lalu buka ORVIX dari ikonnya')}</ol>`;
  else inner = head() + pts + `<ol class="inst-steps">${step(1, `Buka menu titik tiga ${SVG(I_DOTS, 16)} di Chrome atau Edge`)}${step(2, 'Pilih <b>Instal aplikasi</b> atau <b>Tambahkan ke layar utama</b>')}${step(3, 'Konfirmasi, lalu buka ORVIX dari ikonnya')}</ol><p class="inst-note">Firefox desktop belum mendukung pemasangan.</p>`;
  box.innerHTML = `<div class="inst">${inner}</div>`;
  const bi = $('#btnInstall');
  if (bi) bi.onclick = async () => {
    bi.disabled = true; const r = await promptInstall();
    if (r === 'accepted') toast('ORVIX terpasang. Buka dari ikonnya, lalu aktifkan notifikasi.', 'success'); else if (r === 'unavailable') toast('Pemasangan belum bisa dimulai. Pakai menu browser (titik tiga), lalu Instal aplikasi.', 'error');
    paintInstall();
  };
}
async function paintPush() {
  const box = $('#pushBox'); if (!box) return;
  box.innerHTML = sr('', 'Notifikasi', 'Memeriksa status…');
  const st = await pushStatus(me.id); if ($('#pushBox') !== box) return;   // halaman dirender ulang saat menunggu
  if (!st.supported) {
    if (st.iosNeedsInstall) return void (box.innerHTML = sr('', 'Notifikasi', 'Di iPhone/iPad, pasang ORVIX ke Layar Utama dulu (Bagikan, Tambahkan ke Layar Utama), lalu buka dari ikonnya dan aktifkan di sini.'));
    if ('Notification' in window) {   // cadangan: notifikasi hanya saat ORVIX terbuka
      const on = localStorage.getItem('orvix_notif') === '1' && Notification.permission === 'granted';
      box.innerHTML = sr('', 'Notifikasi', 'Browser ini tidak mendukung push. Notifikasi hanya muncul saat ORVIX terbuka.', sw('swNotif', on, 'Notifikasi'));
      $('#swNotif').onclick = gd(async () => { if (on) { localStorage.setItem('orvix_notif', '0'); return paintPush(); } const p = await Notification.requestPermission(); if (p !== 'granted') return toast('Izin notifikasi ditolak di browser', 'error'); localStorage.setItem('orvix_notif', '1'); paintPush(); });
      return;
    }
    return void (box.innerHTML = sr('', 'Notifikasi', 'Browser ini tidak mendukung notifikasi push.'));
  }
  if (!st.configured) return void (box.innerHTML = sr('', 'Notifikasi', 'Belum dikonfigurasi di server (kunci VAPID belum diisi).'));
  if (st.permission === 'denied') return void (box.innerHTML = sr('', 'Notifikasi', 'Izin ditolak di browser. Ubah lewat pengaturan situs (ikon gembok), lalu muat ulang halaman.'));
  box.innerHTML = sr('', 'Notifikasi', st.subscribed ? 'Aktif di perangkat ini.' : 'Terima pesan, permintaan pertemanan, dan panggilan di perangkat ini.', sw('swNotif', st.subscribed, 'Notifikasi')) + (st.subscribed ? '<div id="prefBox"></div>' : '');
  const sb2 = $('#swNotif');
  sb2.onclick = async () => {
    sb2.disabled = true;
    try { if (st.subscribed) { await disablePush(me.id); toast('Notifikasi dinonaktifkan di perangkat ini', 'success'); } else { await enablePush(me.id); toast('Notifikasi aktif', 'success'); } }
    catch (e) { toast(e.message || errMsg(e), 'error'); }
    paintPush();
  };
  if (st.subscribed) paintPrefs();
}
async function paintPrefs() {
  const box = $('#prefBox'); if (!box) return;
  let pr; try { pr = await getPrefs(); } catch (e) { box.innerHTML = `<p class="dim" style="margin:6px 16px">Preferensi tidak dapat dimuat: ${esc(errMsg(e))}</p>`; return; }
  if ($('#prefBox') !== box) return;
  const items = [['messages', 'Pesan pribadi', 'Pesan baru dari chat pribadi'], ['groups', 'Pesan grup', 'Pesan baru dari grup'], ['friends', 'Permintaan pertemanan', 'Saat ada yang mengajakmu berteman'], ['calls', 'Panggilan masuk', 'Tergantung dukungan browser dan perangkat; dering di dalam ORVIX tetap berjalan'], ['preview', 'Tampilkan isi pesan', 'Matikan agar notifikasi hanya menulis "Pesan baru"']];
  box.innerHTML = items.map(([k, t, d]) => `<div class="setrow" style="margin-left:14px">${icon('check', 20)}<span class="grow"><b>${t}</b><small>${d}</small></span>${sw('pf_' + k, pr[k], t)}</div>`).join('') + '<div style="margin:8px 16px"><button class="btn" id="btnPushTest">Kirim notifikasi uji</button><p class="dim" id="pushTestMsg" style="margin-top:6px"></p></div>';
  items.forEach(([k]) => { const b = $('#pf_' + k); b.onclick = gd(async () => { const v = b.getAttribute('aria-checked') !== 'true'; b.disabled = true; try { await setPrefs({ [k]: v }); b.setAttribute('aria-checked', String(v)); } finally { b.disabled = false; } }); });
  $('#btnPushTest').onclick = async (e) => { const b = e.currentTarget; setBusy(b, true, 'Mengirim'); try { await sendTest(); $('#pushTestMsg').textContent = 'Uji dikirim lewat server. Jika tidak muncul dalam beberapa detik, periksa izin notifikasi, mode Jangan Ganggu, dan penghemat baterai, atau hubungi admin.'; } catch (x) { $('#pushTestMsg').textContent = errMsg(x); } setBusy(b, false); };
}

// Diagnosa end-to-end: daftar langkah hijau/merah dengan petunjuk perbaikan.
function paintDiag() {
  const box = $('#diagBox'); if (!box) return;
  if (me.role !== 'admin') { box.innerHTML = ''; return; }   // Diagnosa hanya untuk admin (RPC push_diag juga menolak non-admin)
  box.innerHTML = `<div style="margin:8px 16px 4px"><button class="btn block" id="btnDiag">${icon('shield', 18)} Diagnosa notifikasi</button><div id="diagOut" class="diag-out" aria-live="polite"></div></div>`;
  $('#btnDiag').onclick = async (e) => {
    const b = e.currentTarget, out = $('#diagOut'); setBusy(b, true, 'Memeriksa'); out.innerHTML = '';
    const row = (s) => `<div class="diag-row ${s.ok === true ? 'ok' : s.ok === false ? 'bad' : 'warn'}"><span class="diag-dot">${s.ok === true ? icon('check', 14) : icon('x', 14)}</span><span class="grow"><b>${esc(s.title)}</b><small>${esc(s.detail)}</small>${s.ok === false && s.fix ? `<small class="diag-fix">Perbaikan: ${esc(s.fix)}</small>` : ''}</span></div>`;
    try { await diagnose(me.id, (s, all) => { out.innerHTML = all.map(row).join(''); }); } catch (x) { out.innerHTML += `<p class="err">${esc(errMsg(x))}</p>`; }
    const bad = out.querySelectorAll('.diag-row.bad').length; out.insertAdjacentHTML('beforeend', `<p class="dim" style="margin-top:8px">${bad ? bad + ' masalah ditemukan. Perbaiki dari yang paling atas.' : 'Semua pemeriksaan lolos.'}</p>`);
    setBusy(b, false);
  };
}

function render() {
  const joined = new Intl.DateTimeFormat('id-ID', { month: 'long', year: 'numeric' }).format(new Date(me.created_at));
  body.innerHTML = `
  <div class="pcard"><div class="cover ${me.banner_url ? 'has' : ''}" id="cover">${me.banner_url ? `<img class="cover-img" src="${esc(me.banner_url)}" alt="Banner profil" decoding="async" onload="this.classList.add('in')" onerror="this.remove()">` : ''}<span class="cover-fx" aria-hidden="true"></span>
     ${me.banner_url ? `<div class="cover-act"><button class="ibtn" id="camB" aria-label="Ganti banner">${icon('image', 20)}</button><button class="ibtn" id="delB" aria-label="Hapus banner">${icon('trash', 20)}</button></div>` : `<button class="cover-add" id="camB">${icon('image', 18)}<span>Tambah banner</span></button>`}</div>
   <span class="avw pav">${avatar(me.display_name, me.avatar_url, 96)}<button class="avcam" id="cam" aria-label="Ganti foto profil">${icon('camera', 18)}</button></span>
   <h2 style="margin-top:10px;font-size:22px">${nameWithBadge(me.display_name, me.is_verified, 22, true, me.id)} <button class="ibtn" id="editP" aria-label="Edit profil" style="display:inline-grid;vertical-align:middle">${icon('edit', 18)}</button></h2>
   <p class="dim">@${esc(me.username)}</p>
   <p class="pid" style="margin-top:6px"><span>ID ${esc(me.orvix_id)}</span><button class="ibtn" id="cpId" aria-label="Salin ID ORVIX" style="width:32px;height:32px">${icon('copy', 16)}</button></p>
   <p class="sec" style="margin:12px 0 0">Info</p><p style="margin:2px 16px">${esc(me.status_text || 'Belum ada info')}</p><p class="dim">Bergabung ${joined}</p>
   <button class="btn" id="editP2" style="margin-top:14px">${icon('edit', 18)} Edit profil</button></div>
  <div class="setrow">${icon('globe', 24)}<span class="grow"><b>Profil publik</b><small>Siapa pun bisa melihat foto dan statusmu</small></span>${sw('swPub', me.profile_public, 'Profil publik')}</div>
  <p class="sec">Aplikasi dan notifikasi</p>
  <div id="installBox"></div>
  <div id="pushBox"></div><div id="diagBox"></div>
  <p class="sec">Privasi</p>
  <button class="setrow" id="rowStory">${icon('updates', 24)}<span class="grow"><b>Siapa yang bisa melihat story-ku</b><small>${VIS[me.story_visibility]} (default untuk story baru)</small></span>${icon('chev', 18)}</button>
  <button class="setrow" id="rowMsg">${icon('msg', 24)}<span class="grow"><b>Siapa yang dapat mengirim pesan kepada saya?</b><small>${MSGP[me.who_can_message || 'friends'][0]}</small></span>${icon('chev', 18)}</button>
  <div class="setrow">${icon('clock', 24)}<span class="grow"><b>Terakhir aktif dan status online</b><small>${me.show_last_seen ? 'Terlihat oleh teman dan lawan chat' : 'Disembunyikan'}</small></span>${sw('swSeen', me.show_last_seen, 'Tampilkan terakhir aktif')}</div>
  <p class="sec">Tampilan</p>
  <div class="themes" role="radiogroup" aria-label="Tema aplikasi">${Object.entries(THEMES).map(([k, [n, d]]) => `<button class="tcard th-${k}" role="radio" aria-checked="${currentTheme() === k}" data-th="${k}">
    <span class="tphone" aria-hidden="true"><span class="tbar"><i class="tav"></i><i class="tl"></i><i class="tl s"></i></span><span class="tbody"><span class="tb in"></span><span class="tb out"></span><span class="tb in s"></span><span class="tb out s"></span></span><span class="tin"><i></i><b></b></span></span>
    <span class="tmeta"><span class="tname"><b>${n}</b><span class="tchk" aria-hidden="true">${icon('check', 14)}</span></span><small>${d}</small><span class="tdots" aria-hidden="true"><i></i><i></i><i></i><i></i></span></span></button>`).join('')}</div>
  <button class="setrow" id="rowWp">${icon('image', 24)}<span class="grow"><b>Wallpaper chat</b><small>Pilih latar chat dan atur kepudarannya (0-100).</small></span>${icon('chev', 18)}</button>
  <p class="sec">Akun</p>
  <button class="setrow" id="rowPrem">${icon('badge', 24)}<span class="grow"><b>ORVIX Premium</b><small>${isPremium(me) ? 'Aktif sampai ' + new Intl.DateTimeFormat('id-ID', { dateStyle: 'long' }).format(new Date(me.premium_until)) + '. Atur gaya Premium-mu.' : 'Gaya bubble, aura profil, insight chat, dan lainnya.'}</small></span>${icon('chev', 18)}</button>
  <button class="setrow" id="rowVerif">${icon('badge', 24)}<span class="grow"><b>Ajukan badge</b><small>Verified, Creator, atau Business. Dinilai oleh tim ORVIX.</small></span>${icon('chev', 18)}</button>
  <button class="setrow" id="rowPhoto">${icon('camera', 24)}<span class="grow"><b>Ganti foto profil</b></span>${icon('chev', 18)}</button>
  <button class="setrow" id="rowDelPhoto">${icon('trash', 24)}<span class="grow"><b>Hapus foto profil</b></span>${icon('chev', 18)}</button>
  <button class="setrow" id="rowBanner">${icon('image', 24)}<span class="grow"><b>${me.banner_url ? 'Ganti banner profil' : 'Tambah banner profil'}</b><small>Gambar panjang di atas profilmu. Kamu bisa memotongnya sendiri.</small></span>${icon('chev', 18)}</button>
  ${me.banner_url ? `<button class="setrow" id="rowDelBanner">${icon('trash', 24)}<span class="grow"><b>Hapus banner profil</b></span>${icon('chev', 18)}</button>` : ''}
  <button class="setrow" id="rowPw">${icon('lock', 24)}<span class="grow"><b>Keamanan akun</b><small>Ubah password</small></span>${icon('chev', 18)}</button>
  <button class="setrow" id="rowBlock">${icon('ban', 24)}<span class="grow"><b>Pengguna diblokir</b><small>Lihat dan buka blokir</small></span>${icon('chev', 18)}</button>
  <a class="setrow" href="/about" style="color:inherit">${icon('globe', 24)}<span class="grow"><b>Tentang ORVIX</b><small>Kenali ORVIX dan fitur-fiturnya</small></span>${icon('chev', 18)}</a>
  <a class="setrow" href="/terms" style="color:inherit">${icon('list', 24)}<span class="grow"><b>Syarat dan privasi</b><small>Baca aturan dan kebijakan data</small></span>${icon('chev', 18)}</a>
  <button class="setrow danger" id="rowDel">${icon('trash', 24)}<span class="grow"><b>Hapus akun</b><small>Hapus permanen akun dan semua datamu</small></span></button>
  <button class="setrow danger" id="rowOut">${icon('logout', 24)}<span class="grow"><b>Logout</b></span></button>
  <input type="file" id="file" accept="image/jpeg,image/png,image/webp" hidden>`;
  if (firstRender) {   // animasi masuk berurutan hanya saat halaman pertama kali dimuat, bukan setiap pengaturan berubah
    firstRender = false; [...body.children].forEach((c, i) => c.style.setProperty('--i', Math.min(i, 14))); body.classList.add('stagger'); setTimeout(() => body.classList.remove('stagger'), 1400);
  }
  wire();
}

function wire() {
  const guard = (fn) => async (e) => { try { await fn(e); } catch (x) { toast(errMsg(x), 'error'); } };
  $('#cpId').onclick = () => copyText(me.orvix_id);
  const pick = (kind) => { pickKind = kind; $('#file').click(); };
  $('#cam').onclick = $('#rowPhoto').onclick = () => pick('avatar');
  $('#camB').onclick = $('#rowBanner').onclick = () => pick('banner');
  $('#file').onchange = guard(async (e) => {
    const f = e.target.files[0], kind = pickKind; e.target.value = ''; if (!f) return;
    const bad = validateImage(f, 25); if (bad) return toast(bad, 'error');   // sumber boleh besar; hasil crop dikompres otomatis di bawah batas 2 MB
    if (kind === 'banner') await saveBanner(f); else await saveAvatar(f);
  });
  $('#rowDelPhoto').onclick = guard(async () => {
    if (!me.avatar_url) return toast('Belum ada foto profil');
    if (!(await confirmDialog({ title: 'Hapus foto profil?', message: 'Foto akan dihapus dari akunmu.', confirmText: 'Hapus', danger: true }))) return;
    await purgeAvatarFiles(me.id); await upd({ avatar_url: null }); render(); toast('Foto dihapus', 'success');
  });
  const delBanner = guard(async () => {
    if (!me.banner_url) return;
    if (!(await confirmDialog({ title: 'Hapus banner?', message: 'Banner akan dihapus dari profilmu.', confirmText: 'Hapus', danger: true }))) return;
    await upd({ banner_url: null }).catch((x) => { throw noBannerCol(x); }); await purgeBannerFiles(me.id).catch(() => {}); render(); toast('Banner dihapus', 'success');
  });
  if ($('#delB')) $('#delB').onclick = delBanner; if ($('#rowDelBanner')) $('#rowDelBanner').onclick = delBanner;
  $('#editP').onclick = $('#editP2').onclick = editProfile;
  const toggle = (id, key) => { $(id).onclick = guard(async (e) => { const b = e.currentTarget, v = b.getAttribute('aria-checked') !== 'true'; b.disabled = true; try { await upd({ [key]: v }); render(); } finally { b.disabled = false; } }); };
  toggle('#swPub', 'profile_public'); toggle('#swSeen', 'show_last_seen');
  paintInstall(); paintPush(); paintDiag();
  $('#rowStory').onclick = () => {
    const m = openModal({ title: 'Visibilitas story', sheet: true, html: `<div class="col">${Object.entries(VIS).map(([k, v]) => `<button class="btn ${k === me.story_visibility ? 'primary' : ''}" data-v="${k}">${v}</button>`).join('')}</div>` });
    m.el.onclick = guard(async (e) => { const v = e.target.closest('[data-v]')?.dataset.v; if (!v) return; await upd({ story_visibility: v }); m.close(); render(); });
  };
  $('#rowWp').onclick = () => wallpaperModal();
  $('#rowPrem').onclick = () => openPremiumHub(me, () => { cacheMe(me); render(); });
  $('#rowMsg').onclick = msgPermModal; $('#rowVerif') && ($('#rowVerif').onclick = verifModal);
  document.querySelectorAll('[data-th]').forEach((b) => b.onclick = guard(async () => {
    const k = b.dataset.th, r = b.getBoundingClientRect(); applyTheme(k, { x: r.left + r.width / 2, y: r.top + r.height / 2 }); render();   // langsung terpasang; sinkron ke akun di latar belakang
    try { await upd({ theme: k }); } catch { toast('Tema tersimpan di perangkat ini, tapi belum tersinkron ke akun.', 'error'); }
  }));
  $('#rowPw').onclick = passwordModal; $('#rowBlock').onclick = blockedModal; $('#rowDel').onclick = deleteModal;
  $('#rowOut').onclick = async () => { if (await confirmDialog({ title: 'Keluar dari ORVIX?', message: 'Kamu perlu masuk lagi untuk memakai akun ini.', confirmText: 'Logout' })) logout(); };
}

async function saveAvatar(f) {
  const blob = await cropImage(f, { aspect: 1, outW: 512, round: true, title: 'Potong foto profil', hint: 'Seret untuk menggeser, cubit atau geser slider untuk zoom. Lingkaran adalah tampilan akhir fotomu.' });
  if (!blob) return;
  toast('Mengunggah foto…'); const path = `${me.id}/avatar-${Date.now()}.${blob.type === 'image/webp' ? 'webp' : 'jpg'}`;
  const up = await sb.storage.from('avatars').upload(path, blob, { contentType: blob.type, cacheControl: '3600' }); if (up.error) throw up.error;
  const url = sb.storage.from('avatars').getPublicUrl(path).data.publicUrl;
  try { await upd({ avatar_url: url }); } catch (x) { sb.storage.from('avatars').remove([path]).catch(() => {}); throw x; }
  const { data } = await sb.storage.from('avatars').list(me.id); const old = (data || []).filter((x) => x.name.startsWith('avatar-') && `${me.id}/${x.name}` !== path).map((x) => `${me.id}/${x.name}`); if (old.length) await sb.storage.from('avatars').remove(old);
  render(); toast('Foto profil diperbarui', 'success');
}
async function saveBanner(f) {
  const blob = await cropImage(f, { aspect: 3, outW: 1500, title: 'Atur banner', hint: 'Bingkai ini persis tampilan banner di profilmu. Seret untuk memilih bagian gambar, cubit atau geser slider untuk zoom.' });
  if (!blob) return;
  toast('Mengunggah banner…'); const path = `${me.id}/banner-${Date.now()}.${blob.type === 'image/webp' ? 'webp' : 'jpg'}`;
  const up = await sb.storage.from('avatars').upload(path, blob, { contentType: blob.type, cacheControl: '3600' }); if (up.error) throw up.error;
  const url = sb.storage.from('avatars').getPublicUrl(path).data.publicUrl;
  try { await upd({ banner_url: url }); } catch (x) { sb.storage.from('avatars').remove([path]).catch(() => {}); throw noBannerCol(x); }
  await purgeBannerFiles(me.id, path).catch(() => {});
  render(); toast('Banner diperbarui', 'success');
}

function editProfile() {
  const m = openModal({ title: 'Edit profil', html: `<form id="ef" novalidate><div class="field"><label for="dn">Nama tampilan</label><input class="inp" id="dn" maxlength="40" value="${esc(me.display_name)}"></div><div class="field"><label for="un">Username</label><input class="inp" id="un" maxlength="20" autocapitalize="none" value="${esc(me.username)}"></div><div class="field"><label for="st">Info / Tentang saya</label><textarea class="inp" id="st" maxlength="139" style="min-height:70px" placeholder="Ceritakan singkat tentang kamu">${esc(me.status_text || '')}</textarea><span class="hint" id="stc">${(me.status_text || '').length}/139 · kosongkan untuk menghapus</span></div><p class="err" id="er" role="alert"></p><button class="btn primary block" id="sv">Simpan</button></form>` });
  $('#st', m.el).oninput = (e) => { $('#stc', m.el).textContent = e.target.value.length + '/139 · kosongkan untuk menghapus'; };
  $('#ef', m.el).onsubmit = async (e) => {
    e.preventDefault(); const er = $('#er', m.el), sv = $('#sv', m.el); er.textContent = '';
    const dn = $('#dn', m.el).value.trim(), un = $('#un', m.el).value.trim().toLowerCase(), st = $('#st', m.el).value.trim();
    if (!dn || dn.length > 40) return (er.textContent = 'Nama tampilan 1-40 karakter.');
    if (!/^[a-z0-9_]{3,20}$/.test(un)) return (er.textContent = 'Username 3-20 karakter: huruf kecil, angka, garis bawah.');
    if (st.length > 139) return (er.textContent = 'Info maksimal 139 karakter.');
    setBusy(sv, true, 'Menyimpan…');
    try {
      if (un !== me.username) { const { data } = await sb.rpc('username_available', { u: un }); if (!data) throw new Error('Username sudah dipakai.'); }
      await upd({ display_name: dn, username: un, status_text: st || null }); m.close(); render(); toast('Profil disimpan', 'success');
    } catch (x) { setBusy(sv, false); er.textContent = x.code === '23505' ? 'Username sudah dipakai.' : errMsg(x); }
  };
}

function msgPermModal() {
  const m = openModal({ title: 'Siapa yang dapat mengirim pesan kepada saya?', sheet: true, html: `<div class="col" role="radiogroup" style="gap:10px">${Object.entries(MSGP).map(([k, [t, d]]) => `<button class="opt ${(me.who_can_message || 'friends') === k ? 'on' : ''}" role="radio" aria-checked="${(me.who_can_message || 'friends') === k}" data-p="${k}"><b>${t}</b><small>${d}</small></button>`).join('')}</div><p class="hint" style="margin-top:12px">Mengubah pengaturan tidak menghapus chat yang sudah ada. Kamu tetap bisa chat dengan temanmu.</p>` });
  m.el.onclick = async (e) => {
    const b = e.target.closest('[data-p]'); if (!b || b.dataset.p === (me.who_can_message || 'friends')) return; b.disabled = true;
    try { await upd({ who_can_message: b.dataset.p }); m.close(); render(); toast('Pengaturan disimpan', 'success'); } catch (x) { b.disabled = false; toast(errMsg(x), 'error'); }
  };
}

const V_CAT = { konten: 'Kreator konten', seni_musik: 'Seniman / musisi', jurnalis_penulis: 'Jurnalis / penulis', toko_bisnis: 'Toko / bisnis', merek: 'Merek (brand)', organisasi: 'Organisasi / komunitas', lainnya: 'Lainnya' };
const V_KIND = { verified: 'Verified', creator: 'Creator', business: 'Business' };
const V_REQ = { verified: 'Siapkan bukti identitas atau akun resmi (KTP/dokumen identitas boleh disamarkan sebagian, atau tautan akun publik yang aktif). Tim ORVIX memeriksa bahwa kamu orang atau organisasi yang asli.', creator: 'Siapkan tautan karya/kanal dan bukti aktivitas konten yang konsisten. Creator tidak otomatis berarti identitasmu terverifikasi.', business: 'Siapkan bukti usaha: izin/NIB, nota atau foto usaha, dan tautan toko/situs. Business tidak otomatis memberi Verified.' };
const V_ST = { pending: 'Menunggu peninjauan', approved: 'Disetujui', rejected: 'Ditolak', need_info: 'Perlu informasi tambahan', revoked: 'Dicabut', superseded: 'Diganti pengajuan baru' };
async function verifModal() {
  const m = openModal({ title: 'Ajukan badge', wide: true, html: '<p class="dim">Memuat…</p>' });
  let rows = []; try { const { data, error } = await sb.from('verification_requests').select('id,kind,category,status,reject_reason,created_at,reviewed_at').order('created_at', { ascending: false }).limit(5); if (error) throw error; rows = data || []; } catch (x) { m.el.innerHTML = `<p class="err">${esc(errMsg(x))}</p>`; return; }
  const last = rows[0], hist = rows.length ? `<p class="sec" style="margin:16px 0 6px">Riwayat</p><div class="col" style="gap:6px">${rows.map((r) => `<div class="card sm"><b>${V_KIND[r.kind] || r.kind} · ${V_CAT[r.category] || r.category}</b> <span class="pill ${r.status === 'rejected' || r.status === 'revoked' ? 'bad' : r.status === 'approved' ? 'good' : ''}">${V_ST[r.status]}</span><br><span class="dim">${relTime(r.created_at)}</span>${r.reject_reason && ['rejected', 'need_info'].includes(r.status) ? `<p class="muted" style="margin-top:4px">Catatan admin: ${esc(r.reject_reason)}</p>` : ''}</div>`).join('')}</div>` : '';
  if (last?.status === 'pending') { m.el.innerHTML = `<div class="alert info">Pengajuanmu sedang ditinjau tim ORVIX. Kami akan memberi tahu kamu saat ada keputusan.</div>${hist}`; return; }
  const cool = last?.status === 'rejected' && last.reviewed_at && Date.now() - new Date(last.reviewed_at) < 30 * 864e5;
  if (cool) { m.el.innerHTML = `<div class="alert warn">Pengajuan terakhir ditolak. Kamu bisa mengajukan lagi 30 hari setelah keputusan.</div>${hist}`; return; }
  m.el.innerHTML = `<p class="muted" style="margin-bottom:12px">Lencana diberikan kepada kreator dan bisnis yang asli dan aktif. Bukti yang kamu unggah disimpan privat dan hanya dilihat admin berwenang.</p>${last?.status === 'need_info' ? `<div class="alert warn" style="margin-bottom:12px">Admin meminta informasi tambahan: ${esc(last.reject_reason || '')}. Kirim ulang pengajuan dengan data yang diminta.</div>` : ''}
  <form id="vf" novalidate><div class="field"><label for="vk">Jenis akun</label><select class="inp" id="vk"><option value="verified">Verified (identitas)</option><option value="creator">Creator</option><option value="business">Business</option></select><p class="hint" id="vreq" style="margin-top:6px"></p></div>
  <div class="field"><label for="vc">Kategori</label><select class="inp" id="vc">${Object.entries(V_CAT).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
  <div class="field"><label for="vd">Tentang kamu / usahamu (20–1000 karakter)</label><textarea class="inp" id="vd" maxlength="1000" style="min-height:90px"></textarea></div>
  <div class="field"><label>Tautan pendukung (opsional, maks. 3)</label><input class="inp vl" placeholder="https://" inputmode="url"><input class="inp vl" placeholder="https://" inputmode="url" style="margin-top:6px"><input class="inp vl" placeholder="https://" inputmode="url" style="margin-top:6px"></div>
  <div class="field"><label for="ve">Bukti pendukung (1–5 berkas: JPG, PNG, WebP, atau PDF, maks. 5 MB)</label><input class="inp" id="ve" type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf"></div>
  <p class="err" id="er" role="alert"></p><button class="btn primary block" id="vs">Kirim pengajuan</button></form>${hist}`;
  const vq = () => { $('#vreq', m.el).textContent = V_REQ[$('#vk', m.el).value]; }; $('#vk', m.el).onchange = vq; vq();
  $('#vf', m.el).onsubmit = async (e) => {
    e.preventDefault(); const er = $('#er', m.el), btn = $('#vs', m.el); er.textContent = '';
    const desc = $('#vd', m.el).value.trim(), files = [...$('#ve', m.el).files], links = [...m.el.querySelectorAll('.vl')].map((x) => x.value.trim()).filter(Boolean);
    if (desc.length < 20) return (er.textContent = 'Deskripsi minimal 20 karakter.');
    if (links.some((l) => !/^https?:\/\/\S{3,300}$/.test(l))) return (er.textContent = 'Tautan harus diawali http:// atau https://');
    if (!files.length || files.length > 5) return (er.textContent = 'Unggah 1–5 berkas bukti.');
    if (files.some((f) => f.size > 5 * 1048576 || !['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(f.type))) return (er.textContent = 'Berkas harus JPG/PNG/WebP/PDF dan maks. 5 MB.');
    setBusy(btn, true, 'Mengunggah…'); const paths = [];
    try {
      for (const f of files) { const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' }[f.type], path = `${me.id}/${crypto.randomUUID()}.${ext}`; const up = await sb.storage.from('verification-docs').upload(path, f, { contentType: f.type }); if (up.error) throw up.error; paths.push(path); }
      const { error } = await sb.rpc('orvix_submit_verification', { p_kind: $('#vk', m.el).value, p_category: $('#vc', m.el).value, p_description: desc, p_links: links, p_evidence: paths });
      if (error) throw error;
      m.close(); toast('Pengajuan terkirim. Kami akan meninjau secepatnya.', 'success');
    } catch (x) { if (paths.length) sb.storage.from('verification-docs').remove(paths).catch(() => {}); setBusy(btn, false); er.textContent = errMsg(x); }
  };
}

function passwordModal() {
  const m = openModal({ title: 'Ubah password', html: `<form id="pf" novalidate><div class="field"><label for="p1">Password baru (min. 8 karakter)</label><input class="inp" id="p1" type="password" autocomplete="new-password"></div><div class="field"><label for="p2">Ulangi password</label><input class="inp" id="p2" type="password" autocomplete="new-password"></div><p class="err" id="er" role="alert"></p><button class="btn primary block" id="sv">Simpan</button></form>` });
  $('#pf', m.el).onsubmit = async (e) => {
    e.preventDefault(); const er = $('#er', m.el), a = $('#p1', m.el).value; er.textContent = '';
    if (a.length < 8) return (er.textContent = 'Password minimal 8 karakter.'); if (a !== $('#p2', m.el).value) return (er.textContent = 'Password tidak sama.');
    setBusy($('#sv', m.el), true); const { error } = await sb.auth.updateUser({ password: a });
    if (error) { setBusy($('#sv', m.el), false); return (er.textContent = errMsg(error)); } m.close(); toast('Password diperbarui', 'success');
  };
}

async function blockedModal() {
  const m = openModal({ title: 'Pengguna diblokir', html: '<div id="bl" class="col"><p class="dim">Memuat…</p></div>' });
  const fail = (x) => /could not find the function|does not exist|permission denied|schema cache/i.test(errMsg(x)) ? 'Fitur blokir belum aktif di database. Jalankan sql-parts/13a-blokir.sql di SQL Editor Supabase, lalu muat ulang.' : errMsg(x);
  const draw = async () => {
    let r = await sb.rpc('orvix_list_blocked'), rows;
    if (!r.error) rows = r.data.map((d) => ({ id: d.user_id, display_name: d.display_name, username: d.username, avatar_url: d.avatar_url, is_verified: d.is_verified }));
    else { const q = await sb.from('blocked_users').select('blocked_id,created_at').order('created_at', { ascending: false }); if (q.error) throw q.error; const pm = await fetchProfiles(q.data.map((d) => d.blocked_id)); rows = q.data.map((d) => ({ id: d.blocked_id, ...(pm.get(d.blocked_id) || { display_name: 'Pengguna', username: '' }) })); }
    $('#bl', m.el).innerHTML = rows.length ? rows.map((p) => `<div class="row gap">${avatar(p.display_name, p.avatar_url, 40)}<span class="grow">${nameWithBadge(p.display_name, p.is_verified)}<br><span class="dim">${p.username ? '@' + esc(p.username) : ''}</span></span><button class="btn sm" data-u="${p.id}">Buka blokir</button></div>`).join('') : '<div class="empty" style="padding:24px"><p>Tidak ada pengguna diblokir.</p></div>';
  };
  m.el.onclick = async (e) => { const b = e.target.closest('[data-u]'); if (!b) return; setBusy(b, true); const { error } = await sb.rpc('unblock_user', { target: b.dataset.u }); if (error) { setBusy(b, false); return toast(fail(error), 'error'); } toast('Blokir dibuka', 'success'); draw().catch(() => {}); };
  draw().catch((x) => { $('#bl', m.el).innerHTML = `<p class="err">${esc(fail(x))}</p>`; });
}

function deleteModal() {
  const m = openModal({ title: 'Hapus akun permanen', html: `<div class="alert warn" style="margin-bottom:14px"><b>Tindakan ini tidak bisa dibatalkan.</b><ul style="padding-left:18px;margin-top:6px"><li>Profil, ID ORVIX, dan foto profilmu dihapus.</li><li>Pesan yang kamu kirim, story, dan daftar temanmu ikut terhapus.</li><li>Kamu keluar dari semua grup.</li></ul></div><div class="field"><label for="cf">Ketik username kamu (<b>${esc(me.username)}</b>) untuk konfirmasi</label><input class="inp" id="cf" autocapitalize="none" autocomplete="off"></div><p class="err" id="er" role="alert"></p><button class="btn danger block" id="go" disabled>Hapus akun saya</button>` });
  const cf = $('#cf', m.el), go = $('#go', m.el);
  cf.oninput = () => { go.disabled = cf.value.trim().toLowerCase() !== me.username; };
  go.onclick = async () => {
    setBusy(go, true, 'Menghapus…');
    if (cf.value.trim().toLowerCase() === me.username) await purgeUserFiles(me.id).catch(() => {});   // bersihkan avatar & story milik sendiri
    const { error } = await sb.rpc('delete_my_account', { confirm_username: cf.value.trim().toLowerCase() });
    if (error) { setBusy(go, false); $('#er', m.el).textContent = errMsg(error); return; }
    cacheMe(null);
    await sb.auth.signOut(); location.replace('/');
  };
}
render();
