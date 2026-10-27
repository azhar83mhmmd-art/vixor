// PWA: registrasi service worker + prompt instalasi. Tanpa dependensi agar bisa dimuat di semua halaman (termasuk landing).
let deferred = null; const ev = new EventTarget(); const emit = () => ev.dispatchEvent(new Event('change'));
export const isStandalone = () => { try { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch { return false; } };
export const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// true hanya jika browser benar-benar memberi prompt instalasi (tombol Install tidak ditampilkan bila tidak berfungsi)
export const canInstall = () => !!deferred && !isStandalone();
export const onInstallChange = (f) => { ev.addEventListener('change', f); return () => ev.removeEventListener('change', f); };
export async function promptInstall() {
  if (!deferred) return 'unavailable';
  const p = deferred; deferred = null; emit();
  try { p.prompt(); const r = await p.userChoice; return r.outcome; } catch { return 'unavailable'; }
}
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; emit(); });
const LSI = 'orvix_installed';
export const wasInstalled = () => { try { return localStorage.getItem(LSI) === '1'; } catch { return false; } };
addEventListener('appinstalled', () => { deferred = null; try { localStorage.setItem(LSI, '1'); } catch { /* abaikan */ } emit(); });
if (isStandalone()) { try { localStorage.setItem(LSI, '1'); } catch { /* abaikan */ } }
matchMedia && matchMedia('(display-mode: standalone)').addEventListener && matchMedia('(display-mode: standalone)').addEventListener('change', emit);

export async function registerSW() {
  if (!('serviceWorker' in navigator) || !isSecureContext) return null;   // localhost dianggap aman; selain itu wajib HTTPS
  try { return await navigator.serviceWorker.register('/sw.js', { scope: '/' }); } catch (e) { console.warn('[pwa] service worker gagal didaftarkan', e); return null; }
}
if (document.readyState === 'complete') registerSW(); else addEventListener('load', registerSW);
