-- ORVIX fitur baru, BAGIAN 8/9: fungsi pengisi 12 saluran resmi (belum dijalankan)
create or replace function public.seed_official_channels() returns integer
language plpgsql security definer set search_path = public as $$
declare v_owner uuid; n integer := 0; cid uuid; r record;
begin
  if auth.uid() is not null and not public.is_admin() then raise exception 'Hanya admin'; end if;
  select id into v_owner from public.profiles where role = 'admin' and not is_suspended order by created_at limit 1;
  if v_owner is null then raise exception 'Belum ada akun admin. Jadikan satu akun admin dulu (README langkah 7).'; end if;
  for r in select * from (values
    ('info-orvix','Info ORVIX','Pengumuman, fitur baru, dan tips resmi dari tim ORVIX.','Selamat datang di ORVIX! Di sini kami mengabarkan fitur baru dan pembaruan penting.'),
    ('tips-orvix','Tips & Trik ORVIX','Cara memakai ORVIX lebih cepat: ID unik, grup, story, dan saluran.','Tip: bagikan ID ORVIX 8 angka kamu agar teman bisa menambahkanmu tanpa nomor telepon.'),
    ('teknologi','Teknologi & Gadget','Ulasan singkat dan kabar seputar teknologi.','Jaga akunmu: pakai kata sandi unik dan jangan bagikan kode verifikasi ke siapa pun.'),
    ('belajar-coding','Belajar Coding','Catatan ringan untuk pemula dan developer.','Mulai dari proyek kecil yang selesai, lalu tambah fitur sedikit demi sedikit.'),
    ('produktivitas','Produktivitas Harian','Kebiasaan kecil supaya hari lebih terarah.','Tulis 3 hal terpenting hari ini. Kerjakan yang paling sulit lebih dulu.'),
    ('musik','Musik & Playlist','Rekomendasi lagu dan obrolan musik.','Punya lagu favorit yang jarang dikenal? Ceritakan di grup temanmu.'),
    ('gaming','Gaming Corner','Kabar game, tips, dan ajakan main bareng.','Buat grup ORVIX untuk timmu dan atur jadwal mabar.'),
    ('olahraga','Olahraga & Kebugaran','Motivasi dan kebiasaan sehat sehari-hari.','Mulai dari 10 menit jalan kaki setiap hari. Kecil tapi rutin.'),
    ('kuliner','Kuliner Nusantara','Inspirasi masakan dan jajanan khas Indonesia.','Bumbu dasar putih, merah, dan kuning bisa jadi banyak masakan.'),
    ('desain','Desain & Kreatif','Inspirasi desain, warna, dan tipografi.','Batasi diri pada 2 font dan 3 warna utama agar desain rapi.'),
    ('inggris','Belajar Bahasa Inggris','Kosakata dan ungkapan praktis tiap hari.','Hari ini: "Take your time" artinya jangan terburu-buru.'),
    ('motivasi','Motivasi & Mindset','Pengingat positif untuk melangkah lagi.','Progres kecil tetap progres. Cukup lebih baik sedikit dari kemarin.')
  ) as t(slug, title, descr, first_post) loop
    if not exists (select 1 from public.conversations c where c.slug = r.slug) then
      insert into public.conversations (type, title, description, is_public, is_official, created_by, slug, invite_code)
        values ('channel', r.title, r.descr, true, true, v_owner, r.slug, public.new_invite_code())
        returning id into cid;
      insert into public.conversation_members (conversation_id, user_id, role) values (cid, v_owner, 'owner');
      insert into public.messages (conversation_id, sender_id, content) values (cid, v_owner, r.first_post);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
