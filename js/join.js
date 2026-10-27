// Halaman link undangan: /join/<kode>. Pratinjau terbuka tanpa login; bergabung butuh akun.
import { sb, errMsg } from './supabase.js';
import { $, esc, icon, verifiedBadge, injectSprite, toast, setBusy, copyText, badgeHtml } from './utils.js';
injectSprite();
const card = $('#card'), code = (location.pathname.split('/')[2] || new URLSearchParams(location.search).get('c') || '').trim();
const num = (n) => Number(n).toLocaleString('id-ID');
const hue = (t) => [...String(t)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);
const fail = (t, p, ic = 'link') => { card.className = 'inv inv-state'; card.innerHTML = `<span class="inv-sico">${icon(ic, 30)}</span><h2>${t}</h2><p class="muted">${p}</p><a class="btn primary block" href="/chat" style="margin-top:18px">Buka ORVIX</a>`; };
const skeleton = () => { card.className = 'inv'; card.innerHTML = '<div class="inv-banner sk-b"></div><div class="inv-body"><span class="inv-av sk"></span><i class="sk-l w60"></i><i class="sk-l w40"></i><i class="sk-l w90"></i><i class="sk-btn"></i></div>'; };
skeleton();
(async () => {
  if (!/^[A-Za-z0-9]{6,32}$/.test(code)) return fail('Link tidak valid', 'Periksa kembali link yang kamu terima.', 'ban');
  const [{ data }, { data: ses }] = await Promise.all([sb.rpc('invite_preview', { code }), sb.auth.getSession()]);
  const c = data?.[0]; if (!c) return fail('Link tidak ditemukan', 'Link ini salah atau sudah tidak berlaku. Minta pemilik untuk mengirim link baru.', 'ban');
  const ch = c.kind === 'channel', logged = !!ses.session, go = () => (ch ? '/updates?ch=' : '/chat?c=') + c.conv_id, h = hue(c.title), full = !ch && c.members >= 50;
  document.title = `${c.title} — Undangan ORVIX`;
  const perks = ch ? [['megaphone', 'Update langsung', 'Terima kabar terbaru dari pemilik saluran.'], ['lock', 'Aman dan terkontrol', 'Hanya pemilik yang bisa mengirim pesan.'], ['logout', 'Bebas berhenti', 'Berhenti mengikuti kapan saja.']] : [['users', 'Ngobrol bersama', 'Bergabung dan chat dengan semua anggota grup.'], ['shield', 'Dilindungi ORVIX', 'Pengguna dapat memblokir dan melaporkan.'], ['logout', 'Bebas keluar', 'Keluar dari grup kapan saja.']];
  card.className = 'inv'; card.style.setProperty('--h', h);
  card.innerHTML = `<div class="inv-banner"><span class="inv-pill">${icon(ch ? 'megaphone' : 'users', 14)} ${ch ? 'Undangan saluran' : 'Undangan grup'}</span></div>
  <div class="inv-body"><div class="inv-av" aria-hidden="true"><b>${esc((c.title || '?').trim().charAt(0).toUpperCase())}</b></div>
    <h1 class="inv-name">${esc(c.title)}${c.is_official ? badgeHtml('official', 22, true) : ''}</h1>
    <div class="inv-stats"><span>${icon('users', 16)}<b>${num(c.members)}</b> ${ch ? 'pengikut' : 'anggota'}</span><span>${icon(ch ? 'megaphone' : 'chat', 16)}${ch ? 'Saluran' : 'Grup'}</span>${c.joined ? `<span class="ok">${icon('check', 16)}Sudah bergabung</span>` : ''}</div>
    ${c.description ? `<p class="inv-desc">${esc(c.description)}</p>` : ''}
    <ul class="inv-perks">${perks.map(([i, t, d]) => `<li><span>${icon(i, 18)}</span><div><b>${t}</b><small>${d}</small></div></li>`).join('')}</ul>
    <p class="err" id="je" role="alert"></p>
    <button class="btn primary lg block" id="jb" ${full && !c.joined ? 'disabled' : ''}>${c.joined ? 'Buka sekarang' : full ? 'Grup sudah penuh' : !logged ? 'Masuk untuk bergabung' : ch ? 'Ikuti saluran' : 'Gabung grup'}</button>
    ${!logged && !c.joined ? `<a class="btn block" href="/?next=${encodeURIComponent('/join/' + code)}" style="margin-top:10px">Belum punya akun? Daftar gratis</a>` : ''}
    <div class="inv-share"><button class="btn sm ghost" id="jc">${icon('copy', 16)} Salin link</button><button class="btn sm ghost" id="js">${icon('share', 16)} Bagikan</button></div>
    <p class="inv-trust">${icon('lock', 14)} Link undangan resmi ORVIX. Kami tidak pernah meminta password lewat link.</p></div>`;
  $('#jc').onclick = () => copyText(location.href.split('#')[0]);
  $('#js').onclick = async () => { if (navigator.share) { try { await navigator.share({ title: c.title, text: `Gabung ${c.title} di ORVIX`, url: location.href }); } catch { /* batal */ } } else copyText(location.href); };
  $('#jb').onclick = async (e) => {
    if (c.joined) return location.assign(go());
    if (!logged) return location.assign('/?next=' + encodeURIComponent('/join/' + code));
    setBusy(e.currentTarget, true, 'Bergabung…');
    const { error } = await sb.rpc('join_by_invite', { code });
    if (error) { setBusy(e.currentTarget, false); return ($('#je').textContent = errMsg(error)); }
    toast(ch ? 'Kamu mengikuti saluran ini' : 'Kamu bergabung ke grup', 'success'); location.assign(go());
  };
})().catch((e) => fail('Gagal memuat', esc(errMsg(e)), 'refresh'));
