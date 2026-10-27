// Landing + autentikasi Supabase (login, daftar, reset password).
import { sb, configured, errMsg } from './supabase.js';
import { $, esc, icon, openModal, setBusy, toast, injectSprite } from './utils.js';
injectSprite();

const nextUrl = () => { const n = new URLSearchParams(location.search).get('next'); return n && /^\/[^/\\]/.test(n) ? n : '/chat'; };
const params = new URLSearchParams(location.search);
const recovery = location.hash.includes('type=recovery');
if (!configured) $('#setup').classList.remove('hide');
if (params.get('suspended')) toast('Akun kamu dinonaktifkan. Hubungi administrator.', 'error');
if (params.get('noprofile')) toast('Profil tidak ditemukan. Coba daftar ulang atau hubungi administrator.', 'error');


if (configured) {
  sb.auth.onAuthStateChange((ev) => { if (ev === 'PASSWORD_RECOVERY') showNewPassword(); });
  sb.auth.getSession().then(({ data }) => { if (data.session && !recovery) location.replace(nextUrl()); });
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Daftar tanpa konfirmasi email. Utama: Edge Function 'register' (tidak mengirim email). Jika belum di-deploy atau tidak terjangkau
// (error jaringan/CORS/404), otomatis memakai signUp biasa, lalu masuk langsung dengan data yang baru dibuat.
async function registerAccount(em, pw, un, dn) {
  let done = false;
  if (sessionStorage.getItem('orvix:nofn') !== '1') {
    const { data, error } = await sb.functions.invoke('register', { body: { email: em, password: pw, username: un, display_name: dn } });
    if (!error && !data?.error) done = true;
    else {
      const st = error?.context?.status; let msg = data?.error || '';
      try { msg = (await error.context.json()).error || msg; } catch { /* abaikan */ }
      if (msg && (st === 400 || st === 409)) throw new Error(msg);
      if (!st || st === 404 || st >= 500) sessionStorage.setItem('orvix:nofn', '1');
    }
  }
  if (!done) {
    const { data, error } = await sb.auth.signUp({ email: em, password: pw, options: { data: { username: un, display_name: dn } } });
    if (error) throw error;
    if (data.user && data.user.identities?.length === 0) throw new Error('Email sudah terdaftar. Silakan masuk.');
    if (data.session) return;
  }
  const { error: e2 } = await sb.auth.signInWithPassword({ email: em, password: pw });
  if (e2) throw new Error(/not confirmed/i.test(e2.message) ? 'Akun sudah dibuat, tetapi Supabase masih meminta konfirmasi email. Matikan "Confirm email" di Authentication, Providers, Email pada dashboard Supabase, lalu masuk.' : e2.message);
}

const mapErr = (m) => {
  if (/invalid login/i.test(m)) return 'Email atau password salah.';
  if (/not confirmed/i.test(m)) return 'Email belum dikonfirmasi. Cek kotak masukmu.';
  if (/already registered/i.test(m)) return 'Email sudah terdaftar. Silakan masuk.';
  if (/email rate limit/i.test(m)) return 'Batas pengiriman email Supabase tercapai. Matikan "Confirm email" di dashboard Supabase (Authentication, Providers, Email), atau coba lagi nanti.';
  if (/rate limit|too many/i.test(m)) return 'Terlalu banyak percobaan. Tunggu sebentar.';
  if (/banned/i.test(m)) return 'Akun dinonaktifkan. Hubungi administrator.';
  return m;
};
const pwField = (id, label, auto) => `<div class="field"><label for="${id}">${label}</label><div class="pw"><input class="inp" id="${id}" type="password" autocomplete="${auto}" required><button type="button" class="ibtn" data-eye="${id}" aria-label="Tampilkan password">${icon('eye')}</button></div></div>`;

function wireEyes(root) {
  root.querySelectorAll('[data-eye]').forEach((b) => b.onclick = () => {
    const i = root.querySelector('#' + b.dataset.eye), show = i.type === 'password';
    i.type = show ? 'text' : 'password'; b.innerHTML = icon(show ? 'eyeoff' : 'eye'); b.setAttribute('aria-label', show ? 'Sembunyikan password' : 'Tampilkan password');
  });
}

function showAuth(mode = 'login') {
  if (!configured) { toast('Isi js/config.js terlebih dahulu', 'error'); return; }
  const m = openModal({ title: mode === 'login' ? 'Masuk ke ORVIX' : mode === 'register' ? 'Buat akun ORVIX' : 'Reset password', html: '<div id="ab"></div>' });
  const box = m.el.querySelector('#ab');
  const render = (md) => {
    m.root.querySelector('h2').textContent = md === 'login' ? 'Masuk ke ORVIX' : md === 'register' ? 'Buat akun ORVIX' : 'Reset password';
    if (md === 'login') {
      box.innerHTML = `<form id="f" novalidate><div class="field"><label for="em">Email</label><input class="inp" id="em" type="email" autocomplete="email" inputmode="email"></div>${pwField('pw', 'Password', 'current-password')}<p class="err" id="er" role="alert"></p><button class="btn primary block" id="go">Masuk</button></form><div class="row between" style="margin-top:14px"><button class="btn ghost sm" data-s="reset">Lupa password?</button><button class="btn ghost sm" data-s="register">Buat akun</button></div>`;
    } else if (md === 'register') {
      box.innerHTML = `<form id="f" novalidate><div class="field"><label for="dn">Nama tampilan</label><input class="inp" id="dn" maxlength="40" autocomplete="name"></div><div class="field"><label for="un">Username</label><input class="inp" id="un" maxlength="20" autocapitalize="none" autocomplete="username"><span class="hint">3-20 karakter: huruf kecil, angka, garis bawah.</span></div><div class="field"><label for="em">Email</label><input class="inp" id="em" type="email" autocomplete="email" inputmode="email"></div>${pwField('pw', 'Password (min. 8 karakter)', 'new-password')}<p class="err" id="er" role="alert"></p><button class="btn primary block" id="go">Daftar</button></form><div class="row" style="margin-top:14px"><button class="btn ghost sm" data-s="login">Sudah punya akun? Masuk</button></div>`;
    } else {
      box.innerHTML = `<form id="f" novalidate><p class="muted sm" style="margin-bottom:12px">Kami kirim tautan reset ke emailmu.</p><div class="field"><label for="em">Email</label><input class="inp" id="em" type="email" autocomplete="email"></div><p class="err" id="er" role="alert"></p><button class="btn primary block" id="go">Kirim tautan</button></form><div class="row" style="margin-top:14px"><button class="btn ghost sm" data-s="login">Kembali</button></div>`;
    }
    wireEyes(box);
    box.querySelectorAll('[data-s]').forEach((b) => b.onclick = () => render(b.dataset.s));
    const f = box.querySelector('#f'), er = box.querySelector('#er'), go = box.querySelector('#go');
    const fail = (t) => { er.textContent = t; };
    f.onsubmit = async (e) => {
      e.preventDefault(); if (go.disabled) return; fail('');
      const v = (id) => (box.querySelector('#' + id)?.value ?? '').trim();
      const em = v('em'), pw = box.querySelector('#pw')?.value ?? '';
      if (!EMAIL.test(em)) return fail('Masukkan email yang valid.');
      try {
        if (md === 'login') {
          if (!pw) return fail('Masukkan password.');
          setBusy(go, true, 'Masuk…');
          const { error } = await sb.auth.signInWithPassword({ email: em, password: pw });
          if (error) throw error; location.replace(nextUrl());
        } else if (md === 'register') {
          const dn = v('dn'), un = v('un').toLowerCase();
          if (!dn || dn.length > 40) return fail('Nama tampilan 1-40 karakter.');
          if (!/^[a-z0-9_]{3,20}$/.test(un)) return fail('Username 3-20 karakter: huruf kecil, angka, garis bawah.');
          if (pw.length < 8) return fail('Password minimal 8 karakter.');
          setBusy(go, true, 'Mendaftar…');
          const { data: free, error: e1 } = await sb.rpc('username_available', { u: un });
          if (e1) throw e1; if (!free) { setBusy(go, false); return fail('Username sudah dipakai.'); }
          await registerAccount(em, pw, un, dn); location.replace(nextUrl());
        } else {
          setBusy(go, true, 'Mengirim…');
          const { error } = await sb.auth.resetPasswordForEmail(em, { redirectTo: location.origin + location.pathname });
          if (error) throw error;
          setBusy(go, false); toast('Jika email terdaftar, tautan reset sudah dikirim.', 'success'); render('login');
        }
      } catch (x) { setBusy(go, false); fail(mapErr(errMsg(x))); }
    };
    setTimeout(() => box.querySelector('input')?.focus(), 20);
  };
  render(mode);
}

function showNewPassword() {
  const m = openModal({ title: 'Buat password baru', html: `<form id="f" novalidate>${pwField('np', 'Password baru (min. 8 karakter)', 'new-password')}<p class="err" id="er" role="alert"></p><button class="btn primary block" id="go">Simpan password</button></form>` });
  wireEyes(m.el);
  m.el.querySelector('#f').onsubmit = async (e) => {
    e.preventDefault(); const go = m.el.querySelector('#go'), er = m.el.querySelector('#er'), pw = m.el.querySelector('#np').value;
    if (pw.length < 8) { er.textContent = 'Password minimal 8 karakter.'; return; }
    setBusy(go, true, 'Menyimpan…');
    const { error } = await sb.auth.updateUser({ password: pw });
    if (error) { setBusy(go, false); er.textContent = errMsg(error); return; }
    toast('Password diperbarui', 'success'); location.replace(nextUrl());
  };
}

$('#btnAuth').onclick = () => showAuth('login');
if (params.get('reset') && !recovery) showAuth('login');
