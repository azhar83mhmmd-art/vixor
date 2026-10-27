-- ORVIX BAGIAN 12h: Banner profil
-- Aman dijalankan ulang. Tidak menghapus data lama.
-- File banner disimpan di bucket `avatars` (publik, maks. 2 MB) pada folder <user_id>/banner-*.webp,
-- jadi kebijakan Storage yang sudah ada (folder = auth.uid()) otomatis berlaku. Tidak perlu bucket baru.

alter table public.profiles add column if not exists banner_url text;

-- URL banner hanya boleh menunjuk ke folder milik pemilik akun sendiri (mencegah menempel URL orang lain / situs luar)
alter table public.profiles drop constraint if exists profiles_banner_url_check;
alter table public.profiles add constraint profiles_banner_url_check
  check (banner_url is null or (char_length(banner_url) <= 500
    and banner_url like ('%/storage/v1/object/public/avatars/' || id::text || '/banner-%')));

-- Pola yang sama seperti kolom pengaturan lain: pengguna terautentikasi boleh membaca; hanya pemilik (policy profiles_update) yang boleh mengubah
grant select (banner_url) on public.profiles to authenticated;
grant update (banner_url) on public.profiles to authenticated;
