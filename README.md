# ORVIX — Chat Platform

Aplikasi chat dark premium berbasis ID unik. Frontend HTML/CSS/JavaScript vanilla (ES Modules), backend Supabase (Auth, PostgreSQL, Realtime, Storage, RLS, Edge Functions).

## 1. Persyaratan
- Akun Supabase (paket gratis cukup) dan [Supabase CLI](https://supabase.com/docs/guides/cli) untuk deploy Edge Function.
- Server HTTP statis untuk lokal (mis. `python3 -m http.server 8080`) — ES Modules tidak jalan dari `file://`.
- Akun Vercel (opsional) untuk deploy.

## 2. Buat project Supabase
Buat project baru, lalu catat **Project URL** dan **publishable/anon key** (Settings → API).

## 3. Jalankan `supabase.sql`
Buka SQL Editor, tempel isi `supabase.sql`, lalu Run. File dibagi 10 bagian bernomor dan idempotent (aman dijalankan ulang).

## 4. Storage
Bagian 8 di SQL otomatis membuat bucket `avatars` (publik, 2 MB) dan `stories` (privat, 5 MB), lengkap dengan policy per folder `<user_id>/`. Cek di Storage bahwa kedua bucket ada.

## 5. Realtime
Bagian 9 menambahkan `messages`, `friendships`, `conversation_members`, dan `stories` ke publication `supabase_realtime`. Verifikasi di Database → Replication.

## 6. Isi konfigurasi frontend
Edit `js/config.js`:
```js
export const SUPABASE_URL = "https://xxxx.supabase.co";
export const SUPABASE_ANON_KEY = "<publishable/anon key>";
```
Jangan pernah memasukkan `service_role` key ke file frontend. Di Authentication → URL Configuration, tambahkan URL situsmu (mis. `https://orvix.vercel.app`) ke **Site URL** dan **Redirect URLs** agar konfirmasi email dan reset password kembali ke ORVIX.

## 7. Membuat admin pertama (aman)
Tidak ada akun admin bawaan. Daftar akun biasa lewat aplikasi, lalu jalankan **di SQL Editor** (hanya pemilik project yang bisa):
```sql
update public.profiles set role = 'admin' where username = 'username_kamu';
```
Pengguna biasa tidak bisa melakukan ini: hak UPDATE kolom `role`, `is_verified`, `verified_at`, dan `is_suspended` tidak diberikan ke klien.

## 8. Edge Function (opsional)
Panel admin, hapus akun, dan pendaftaran **tidak lagi bergantung pada Edge Function**. Semuanya berjalan lewat RPC database
(`admin_api`, `delete_my_account`) yang dipasang oleh `supabase.sql` bagian 13, sehingga tidak ada lagi galat
"Failed to send a request to the Edge Function" akibat fungsi belum di-deploy atau terblokir CORS.

Folder `supabase/functions` tetap disertakan. Satu-satunya yang berguna untuk di-deploy adalah `register`, karena pendaftaran lewat fungsi itu
tidak mengirim email sama sekali. Tanpa itu, aplikasi otomatis memakai `signUp` biasa.
```bash
supabase functions deploy register --no-verify-jwt
```

## 9. Urutan SQL dan pengaturan wajib
1. Jalankan `supabase.sql` utuh (bagian 1 sampai 13) di SQL Editor. Jika database sudah berisi versi lama, cukup jalankan bagian baru berurutan: 11, 12, 13.
2. Dashboard Supabase, Authentication, Providers, Email: matikan **Confirm email** agar pendaftaran langsung bisa masuk.
3. Authentication, Rate Limits: naikkan batas sign-up/sign-in per IP bila perlu (tidak ada opsi tanpa batas).
4. Storage: bucket `stories` kini menerima foto dan video (maks. 25 MB per berkas, di bawah batas 50 MB Free Plan). Video dibatasi 30 detik di aplikasi.
5. Admin pertama ditetapkan lewat SQL: `update public.profiles set role = 'admin' where username = 'usernamemu';`

6. Saluran: jalankan berurutan file di `sql-parts/` (01 sampai 10), satu file per Run, supaya editor SQL di HP tidak crash. Saluran rekomendasi sepenuhnya buatan pengguna (tanpa saluran resmi bawaan). Setelah deploy ulang frontend, tutup tab lalu buka lagi agar JS lama tidak tersangkut cache.

## 10. Update fitur (bagian 12a–12g)
Jalankan berurutan di SQL Editor, satu file per Run (semua idempotent, tidak menghapus data):
`sql-parts/12a-profil-izin-tema.sql` → `12b-status-pesan.sql` → `12c-pesan-sementara.sql` → `12d-story-reply-repost.sql` → `12e-laporan-moderasi.sql` → `12f-verifikasi.sql` → `12g-kontak.sql` → `12h-banner-profil.sql`
(`update-fitur-orvix.sql` = gabungan kedelapannya, untuk editor desktop).

- **Info profil**: memakai kolom `status_text` yang sudah ada (maks. 139 karakter, hanya pemilik yang bisa mengubah).
- **Centang pesan**: `message_reads` + kolom `last_delivered_at`; status ditulis hanya lewat RPC `mark_read` / `orvix_mark_delivered`.
- **Pesan sementara**: berlaku untuk pesan baru. Deploy pembersih lampiran: `supabase functions deploy purge-expired --no-verify-jwt`, set secret `CRON_SECRET`, lalu jadwalkan (mis. tiap 15 menit) dengan header `x-cron-secret`. Fallback baris teks: panggil `select public.orvix_purge_expired_text();` lewat pg_cron.
- **Verifikasi**: bucket privat `verification-docs` dibuat oleh 12f. Admin meninjau di Admin Center → Verifikasi.
- **Tema**: `profiles.theme` (disinkronkan lintas perangkat) + `localStorage['orvix:theme']`. Tiga tema (ORVIX, Neo Brutalism, Glassmorphism) semuanya gelap dan punya animasi sendiri; pergantian tema menyebar dari titik klik (View Transitions, otomatis mati bila browser tidak mendukung atau `prefers-reduced-motion`).
- **Banner profil**: kolom `profiles.banner_url` (12h). File disimpan di bucket `avatars` pada `<user_id>/banner-*.webp` sehingga kebijakan Storage yang ada tetap berlaku (tidak perlu bucket baru). Banner tampil di profil sendiri dan di layar profil teman.
- **Crop gambar**: memilih foto profil atau banner otomatis membuka editor crop (`js/cropper.js`): geser, cubit/roda mouse/slider untuk zoom. Gambar sumber boleh sampai 25 MB; hasil crop dikompres otomatis (WebP, 1500×500 untuk banner dan 512×512 untuk foto) agar muat di batas 2 MB bucket.
- Bila SQL 12h belum dijalankan, aplikasi tetap berjalan normal; hanya fitur banner yang menampilkan pesan untuk menjalankan SQL tersebut.
- Catatan: `supabase.sql` di repo ini berhenti di bagian 10. Fungsi `admin_api`, `delete_my_account`, dan `story_feed` yang dipakai aplikasi berasal dari SQL lain (mis. `perbaikan-bagian-13.sql`) yang tidak ikut di zip; update ini tidak menimpanya.

## Sistem badge (sql-parts/12i-badge.sql)
Jalankan `12i-badge.sql` di SQL Editor setelah `12f`. Lalu deploy ulang Edge Function `admin-users`.
- Admin utama (bisa kelola Official): `update public.profiles set is_super_admin = true where username = 'USERNAME_ADMIN';`
- Premium hanya bisa diubah backend tepercaya (service_role): `select public.orvix_set_premium('<user_id>', '2026-12-31T00:00:00Z');` (null / masa lalu = nonaktif)


## 11. Update 13: blokir, hapus pesan, kontak, premium (sql-parts 13a–13d)
Jalankan berurutan, satu file per Run (idempotent): `13a-blokir.sql` → `13b-hapus-pesan-chat.sql` → `13c-kontak.sql` → `13d-premium.sql`
(`update-kontak-blokir-premium.sql` = gabungan keempatnya, untuk editor desktop). Lalu deploy ulang frontend dan tutup tab lama.

- **Blokir**: 13a memasang ulang izin eksekusi, membuat `orvix_list_blocked()`, dan memvalidasi sesi. Di chat, composer berganti bar "Buka blokir".
- **Hapus pesan**: hanya dalam 1 jam (dijaga trigger `messages_guard`). Pesan berubah jadi "Pesan ini telah dihapus". Edit: 15 menit (Premium 1 jam).
- **Chat**: tekan lama item chat untuk memilih beberapa, lalu sematkan (maks. 3, Premium 10) atau hapus dari daftar (hanya untukmu).
- **Kontak**: tombol (+) → Kontak. Berisi "Pernah dihubungi" dan "Pernah dicari" (ID ORVIX yang dicari tersimpan otomatis).
- **Premium**: Pusat Premium (ikon mahkota di Chat, atau Profil). Gaya bubble, aksen warna, aura profil, insight chat 30 hari, ekspor chat, sematan 10 chat.

## 11. Responsif dan pilih pesan (tekan lama)
- `css/responsive.css` dimuat terakhir di semua halaman: layout chat tidak lagi melebar mengikuti teks header (grid `minmax(0,1fr)`), ukuran teks fluid (`html{font-size:clamp(...)}`, semua `font-size` kini `rem`), input 16px agar iOS tidak zoom.
- Di dalam chat, tekan lama sebuah pesan untuk memilihnya (seperti memilih chat di daftar). Ketuk pesan lain untuk menambah/melepas. Bar atas menampilkan Salin, Edit (1 pesan milikmu, dalam batas edit), Laporkan (1 pesan orang lain), dan Hapus. Hapus untuk semua hanya untuk pesanmu sendiri dalam 1 jam (batas dari `sql-parts/13b-hapus-pesan-chat.sql`, jalankan jika belum). Tombol Kembali/Esc membatalkan pilihan. Ketuk biasa pada pesan tetap membuka menu lama.

## 12. Panggilan suara & video (sql-parts/14a-panggilan.sql)
Jalankan `14a-panggilan.sql` di SQL Editor (idempotent), lalu deploy ulang frontend dan tutup tab lama.
- **Realtime Authorization**: signaling memakai private Broadcast. Policy `orvix_call_receive` dan `orvix_call_send` dibuat di `realtime.messages` oleh 14a (bila editor tidak punya izin, buat dari Dashboard, Realtime, Policies). Di Project Settings, Realtime, nonaktifkan "Allow public access" bila ingin private channel ditegakkan penuh.
- **Konfigurasi** (tanpa deploy ulang): `update public.call_settings set max_group_video = 4, max_group_voice = 8, ring_timeout_secs = 45, max_starts_per_min = 5 where id = 1;` Batas awal adalah tebakan konservatif, sesuaikan setelah uji perangkat nyata.
- **STUN**: `CALL_STUN` di `js/config.js`. Tidak ada TURN.
- **Akses**: tabel `calls`/`call_participants` hanya bisa dibaca; semua perubahan lewat RPC `call_start/join/leave/decline/heartbeat`. SDP/ICE tidak disimpan.
- **Batasan**: tanpa TURN, koneksi gagal pada NAT simetris/CGNAT/firewall tertentu. Grup memakai mesh (n peserta = n(n-1)/2 koneksi), maka dibatasi. Panggilan putus bila halaman ditutup/dimuat ulang (aplikasi ini multi-halaman) dan tidak ada push notification: dering hanya saat ORVIX terbuka. Peserta dalam satu panggilan saling percaya pada signaling (identitas pengirim tidak diverifikasi kriptografis di dalam panggilan).
- **Debug**: saat panggilan aktif, `await window.__orvixCall.stats()` di konsol menampilkan byte, paket hilang, dan RTT per peserta.

## 13. PWA dan notifikasi push (sql-parts/15a-push.sql)
**PWA**: `manifest.webmanifest`, `sw.js` (hanya push + klik notifikasi, tanpa cache offline), ikon di `assets/icon-*.png`. `vercel.json` menyajikan `sw.js` dengan `Service-Worker-Allowed: /` dan tanpa cache, serta manifest dengan MIME `application/manifest+json`. Tombol "Install ORVIX" di Profil hanya muncul bila browser memberi prompt instalasi; selain itu tampil petunjuk manual. Wajib HTTPS (Vercel otomatis).

**Push, langkah deploy (sekali):**
1. `node scripts/gen-vapid.mjs` menghasilkan 3 nilai. Tempel `VAPID_PUBLIC_KEY` ke `js/config.js`.
2. Secrets Edge Function (hanya ini yang dipakai): `supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:emailmu@domain.com PUSH_WEBHOOK_SECRET=...`. `SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY` disediakan otomatis oleh Supabase; jangan taruh di frontend.
3. `supabase functions deploy push-send --no-verify-jwt` (diamankan header `x-push-secret`, bukan JWT).
4. Jalankan `sql-parts/15a-push.sql`, lalu SEKALI: `select public.push_configure('https://<ref>.supabase.co/functions/v1/push-send', '<PUSH_WEBHOOK_SECRET yang sama>');`
5. Deploy ulang frontend, tutup tab lama. Profil, Notifikasi, aktifkan, lalu "Kirim notifikasi uji" untuk memverifikasi rantai server.

**Aturan**: pengirim tidak pernah menerima notifikasinya sendiri; penerima yang memblokir/diblokir pengirim dilewati; preferensi per jenis dan "tampilkan isi pesan" dihormati; langganan 404/410 dihapus, galat berulang menonaktifkan langganan. Logout melepas perangkat dari akun.

**Batasan jujur**: iPhone/iPad hanya mendukung push untuk ORVIX yang dipasang ke Layar Utama (iOS 16.4+). Notifikasi panggilan bergantung pada browser/OS (dering di layar kunci tidak dijamin; TTL hanya 30 detik). Push tidak berjalan di Firefox untuk Android yang menghemat daya/diblokir pabrikan tertentu, dan HP dengan penghemat baterai agresif dapat menunda atau membuang push. Notifikasi di dalam aplikasi (Realtime) tetap ada; saat Web Push aktif, notifikasi dalam-halaman lama dimatikan agar tidak ganda.


## 16. Pesan lanjutan Premium (terjadwal, draft, pencarian)

**Urutan SQL**: jalankan `sql-parts/16a-pesan-lanjutan.sql` setelah `13b`, `13d`, dan `15a` (aman dijalankan ulang).

- **Pesan terjadwal**: dikirim oleh server, bukan browser. Fungsi `orvix_dispatch_scheduled()` dipanggil `pg_cron` tiap menit. Aktifkan extension **pg_cron** di Dashboard Supabase (Database, Extensions), lalu jalankan ulang bagian 5 file SQL jika muncul NOTICE "pg_cron belum aktif". Tanpa pg_cron pesan tidak terkirim. Verifikasi: `select * from cron.job where jobname = 'orvix-dispatch-scheduled';` dan `select * from cron.job_run_details order by start_time desc limit 5;`.
- Aturan di database: hanya Premium aktif, harus bisa mengirim ke percakapan (anggota, tidak diblokir, tidak ditangguhkan), jadwal 30 detik sampai 1 tahun ke depan, maks. 30 jadwal aktif. Saat jadwal tiba dicek ulang; bila Premium habis atau tidak lagi boleh mengirim, status menjadi Gagal dengan alasannya. Kirim ganda dicegah kunci baris (`FOR UPDATE SKIP LOCKED`) dan `message_id` yang unik.
- **Draft**: tersimpan per pengguna dan per percakapan (tabel `orvix_drafts`, RLS hanya milik sendiri), tersinkron antar perangkat. Khusus Premium; data tetap ada bila Premium berakhir tetapi tidak ditampilkan.
- **Pencarian**: `orvix_search_messages` berjalan dengan hak pengguna (RLS pesan tetap berlaku) dan menghormati "hapus chat". Gratis: kata kunci di satu percakapan. Premium: semua percakapan (90 hari) plus filter pengirim, tanggal, jenis. Tanpa indeks tambahan.
- UI: menu percakapan (titik tiga) dan sheet Mulai (tombol +) di halaman chat; tombol jam di kolom ketik untuk Premium.

**Belum dikerjakan dari daftar fitur Premium** (batch berikutnya): tema dan wallpaper, kustomisasi bubble lanjutan, bingkai avatar dan gaya bio, reaksi dan efek animasi, story Premium, terjemahan pesan (butuh API penerjemah), musik profil, username eksklusif, kontrol tanda baca, alat grup Premium.

**Checklist uji**: (1) akun gratis: tombol jam tidak muncul, menu menampilkan lencana Premium, RPC ditolak; (2) akun Premium: jadwalkan 2 menit lagi, tutup aplikasi, pesan masuk di chat; (3) ubah/batalkan sebelum waktunya; (4) blokir lawan lalu tunggu jadwal: status Gagal; (5) ketik draft, pindah chat, kembali, draft pulih dan di perangkat lain juga; (6) cari `50%` dan `hari_ini`: dicocokkan apa adanya.


## 17. Perbaikan notifikasi + fitur chat baru (sql-parts/17a-fitur-chat.sql)

**Urutan**: jalankan `sql-parts/17a-fitur-chat.sql` di SQL Editor (idempotent), deploy ulang frontend, lalu **deploy ulang Edge Function**: `supabase functions deploy push-send` (file `supabase/config.toml` sudah mematikan verifikasi JWT; `--no-verify-jwt` tidak lagi wajib). Tutup tab lama setelah deploy.

### Notifikasi tidak muncul? Pakai Diagnosa
Profil, bagian Notifikasi, tombol **Diagnosa notifikasi**. Tombol ini memeriksa tiap mata rantai (browser, izin, service worker, langganan, Edge Function, secrets, pasangan kunci VAPID, `push_configure`, pg_net, pemicu, lalu mengirim uji end-to-end dan membaca respons HTTP dari Edge Function) dan menulis perbaikannya. Perbaikan di kode:
- Edge Function tidak lagi menelan galat: membalas 401/500 dengan alasan, dan `GET` publik mengecek VAPID (kunci privat harus pasangan kunci publik).
- `push_configure`/`push_post` memangkas spasi pada secret (penyebab 401 diam-diam) dan batas pg_net naik 3 detik menjadi 15 detik.
- Notifikasi dalam-aplikasi tidak lagi mati total saat push dianggap aktif; keduanya memakai `tag` sama sehingga tidak dobel.
- Saluran: judul notifikasi memakai nama saluran. Chat dibisukan tidak mengirim notifikasi. Chat terkunci hanya menulis "Pesan baru".

### Fitur chat baru
Balas pesan (ketuk pesan, atau geser ke kanan), kutipan yang bisa diketuk untuk loncat ke pesan asli; **pesan suara** (rekam, jeda, gelombang suara, putar 1×/1.5×/2×, geser untuk mencari); reaksi emoji; teruskan pesan (teks dan media, hingga 5 chat); pesan berbintang; **arsipkan chat** (muncul lagi saat ada pesan baru); **kunci chat** dengan PIN; bisukan (8 jam/1 minggu/selamanya); tandai belum dibaca; filter "Belum dibaca"; indikator sedang mengetik; pemilih emoji; tombol ke pesan terbaru dengan penghitung.

**Catatan jujur**
- Kunci chat adalah pengaman layar per perangkat (PIN di-hash PBKDF2 dan hanya disimpan di perangkat ini; lupa PIN diatur ulang dengan kata sandi akun). Ini bukan enkripsi: pesan tetap terbaca dari perangkat lain yang login ke akun yang sama.
- Pesan suara butuh HTTPS dan izin mikrofon. Maksimal 10 menit per pesan.
- Indikator mengetik memakai Realtime Broadcast publik. Bila "Allow public access" dimatikan di pengaturan Realtime, indikator diam saja; fitur lain tidak terpengaruh.
- Bila 17a belum dijalankan, aplikasi tetap berjalan; fitur baru menampilkan pesan agar menjalankan SQL tersebut.


## 18. Perbaikan notifikasi: pg_net, pemicu, CORS lokal (sql-parts/18a-perbaiki-push.sql)

Gejala Diagnosa: "Tidak terjangkau dari browser: Failed to fetch", "Ekstensi pg_net belum aktif", "Pemicu pesan baru tidak ada".
1. Jalankan `sql-parts/18a-perbaiki-push.sql` di SQL Editor (kecil, sekali tempel). Hasil akhir harus `pg_net = true`, `jumlah_pemicu >= 2`. Bila pg_net masih gagal: Dashboard, Database, Extensions, aktifkan pg_net, lalu jalankan ulang file ini.
2. Deploy ulang fungsi: `supabase functions deploy push-send` (CORS kini otomatis mengizinkan localhost/LAN dan GET kesehatan terbuka).
3. Deploy ulang frontend, muat ulang Profil, tekan Diagnosa. Bila CORS masih memblokir, Diagnosa kini menyebut origin yang ditolak.

**Diagnosa khusus admin**: tombol "Diagnosa notifikasi" hanya tampil untuk akun role admin, dan RPC `push_diag` menolak non-admin ("Khusus admin."). Jalankan `sql-parts/18b-diagnosa-admin.sql` sekali.

## 19. Centang pesan seperti WhatsApp
- Jam = menunggu koneksi pengirim (teks dikirim otomatis saat online lagi). Satu centang = tersimpan di server. Dua abu-abu = perangkat penerima menerima (aplikasi terbuka, atau push tiba lewat service worker, RPC `push_ack`). Dua biru = sudah dibaca.
- Jalankan `sql-parts/18c-centang-diterima.sql`, deploy ulang `push-send` dan frontend.
