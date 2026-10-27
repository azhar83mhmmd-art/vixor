-- ORVIX BAGIAN 12j: tetapkan admin utama (diperlukan untuk badge Official). Aman dijalankan ulang.
-- 1) Otomatis: bila belum ada admin utama, admin paling lama dijadikan admin utama.
update public.profiles set is_super_admin = true
where id = (select id from public.profiles where role = 'admin' and not is_suspended order by created_at asc limit 1)
  and not exists (select 1 from public.profiles where is_super_admin);

-- 2) Atau tentukan sendiri (ganti USERNAME, hapus tanda -- di depan):
-- update public.profiles set is_super_admin = true where username = 'USERNAME' and role = 'admin';

-- Cek hasilnya:
select username, role, is_super_admin from public.profiles where role = 'admin';
