/* ORVIX service worker: HANYA Web Push + klik notifikasi. Sengaja tanpa cache offline
   (tidak ada risiko JS/CSS lama tersangkut). Scope "/" karena file ada di akar situs. */
const ICON = '/assets/icon-192.png', BADGE = '/assets/badge-96.png';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Handler fetch kosong (tanpa cache): syarat installability di sebagian versi Chrome Android. Semua request tetap langsung ke jaringan.
self.addEventListener('fetch', () => {});

// Payload dari Edge Function push-send: { type, title, body, tag, url, count?, ttl?, requireInteraction? }
function parse(event) {
  try { const d = event.data && event.data.json(); return d && typeof d === 'object' ? d : null; } catch { return null; }
}

self.addEventListener('push', (event) => {
  const d = parse(event);
  event.waitUntil((async () => {
    if (!d || typeof d.title !== 'string') return self.registration.showNotification('ORVIX', { body: 'Ada pembaruan baru.', icon: ICON, badge: BADGE, tag: 'orvix-generic' });
    // Tanda "diterima" (centang 2 abu-abu): perangkat ini benar-benar menerima push. Endpoint langganan = bukti identitas perangkat.
    if (d.ack && typeof d.ack.u === 'string' && d.ack.u.startsWith('https://')) {
      try {
        const sub = await self.registration.pushManager.getSubscription();
        if (sub) await fetch(d.ack.u, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', apikey: d.ack.k, Authorization: 'Bearer ' + d.ack.k }, body: JSON.stringify({ ep: sub.endpoint, conv: d.ack.c }) });
      } catch { /* tanpa internet / gagal: centang tetap satu */ }
    }
    // Jika ORVIX sedang terbuka, terlihat, dan difokuskan, Realtime sudah menampilkannya di dalam aplikasi.
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((c) => c.focused && c.visibilityState === 'visible')) return;
    const tag = String(d.tag || d.type || 'orvix').slice(0, 80);
    let count = 1;
    if (d.type === 'message') {   // gabungkan pesan beruntun dari percakapan yang sama jadi satu notifikasi
      const old = await self.registration.getNotifications({ tag });
      if (old.length) count = ((old[0].data && old[0].data.count) || 1) + 1;
    }
    const title = count > 1 ? `${String(d.title).slice(0, 80)} (${count})` : String(d.title).slice(0, 90);
    await self.registration.showNotification(title, {
      body: String(d.body || '').slice(0, 160), icon: ICON, badge: BADGE, tag, renotify: true,
      requireInteraction: d.type === 'call', silent: false,
      vibrate: d.type === 'call' ? [400, 200, 400, 200, 400] : [150, 80, 150],   // getar membantu notifikasi tampil sebagai banner (heads-up) di banyak HP
      data: { url: typeof d.url === 'string' && d.url.startsWith('/') ? d.url : '/chat', type: d.type, count },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/chat', self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const same = wins.find((c) => new URL(c.url).origin === self.location.origin);
    if (same) { try { await same.focus(); if ('navigate' in same) await same.navigate(url); return; } catch { /* jatuh ke openWindow */ } }
    await self.clients.openWindow(url);
  })());
});

// Langganan kedaluwarsa/diganti browser: aplikasi memperbaruinya saat dibuka berikutnya (js/push.js, syncPush).
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ws) => ws.forEach((w) => w.postMessage({ type: 'push-resync' }))));
});
