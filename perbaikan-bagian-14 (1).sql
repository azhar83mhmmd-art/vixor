-- ---------- 14. FOTO/VIDEO DI CHAT, SALURAN (jalankan setelah bagian 13) ----------
-- 14a. Lampiran chat (bucket privat, akses berdasarkan keanggotaan percakapan)
alter table public.messages add column if not exists media_path text;
alter table public.messages add column if not exists media_type text check (media_type in ('image','video'));
alter table public.messages add column if not exists thumb_path text;
alter table public.messages add column if not exists duration_ms integer check (duration_ms is null or duration_ms between 1000 and 120000);
alter table public.messages add column if not exists media_w integer;
alter table public.messages add column if not exists media_h integer;
do $$ declare r record; begin
  for r in select conname from pg_constraint where conrelid = 'public.messages'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%message_type%' loop
    execute format('alter table public.messages drop constraint %I', r.conname); end loop; end $$;
alter table public.messages add constraint messages_message_type_check check (message_type in ('text','image','video'));
grant insert (message_type, media_path, media_type, thumb_path, duration_ms, media_w, media_h) on public.messages to authenticated;
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated with check (sender_id = auth.uid() and public.can_send(conversation_id) and (
  (message_type = 'text' and media_path is null and char_length(btrim(content)) between 1 and 4000)
  or (message_type in ('image','video') and media_type = message_type and char_length(content) <= 1000
      and media_path like conversation_id::text || '/' || sender_id::text || '/%' and (thumb_path is null or thumb_path like conversation_id::text || '/' || sender_id::text || '/%'))));
create or replace function public.messages_guard() returns trigger language plpgsql as $$
begin
  if auth.uid() is null then return new; end if;
  if new.conversation_id <> old.conversation_id or new.sender_id <> old.sender_id or new.created_at <> old.created_at or new.message_type <> old.message_type then
    raise exception 'Kolom pesan ini tidak dapat diubah'; end if;
  if old.deleted_at is not null then raise exception 'Pesan sudah dihapus'; end if;
  if new.deleted_at is not null then new.deleted_at := now(); new.content := ''; new.media_path := null; new.thumb_path := null;
  elsif new.content is distinct from old.content then
    if old.message_type <> 'text' then raise exception 'Pesan lampiran tidak bisa diedit'; end if;
    if now() - old.created_at > interval '15 minutes' then raise exception 'Batas waktu edit pesan 15 menit'; end if;
    if char_length(btrim(new.content)) < 1 then raise exception 'Pesan tidak boleh kosong'; end if;
    new.edited_at := now();
  end if;
  return new;
end $$;
create or replace function public.path_uuid(p text) returns uuid language plpgsql immutable as $$ begin return split_part(p, '/', 1)::uuid; exception when others then return null; end $$;
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values ('chat-media', 'chat-media', false, 26214400, array['image/jpeg','image/png','image/webp','video/mp4','video/webm','video/quicktime'])
  on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists chat_media_select on storage.objects;
create policy chat_media_select on storage.objects for select to authenticated using (bucket_id = 'chat-media' and public.is_member(public.path_uuid(name)));
drop policy if exists chat_media_insert on storage.objects;
create policy chat_media_insert on storage.objects for insert to authenticated with check (bucket_id = 'chat-media' and (storage.foldername(name))[2] = auth.uid()::text and public.can_send(public.path_uuid(name)));
drop policy if exists chat_media_delete on storage.objects;
create policy chat_media_delete on storage.objects for delete to authenticated using (bucket_id = 'chat-media' and (storage.foldername(name))[2] = auth.uid()::text);
drop function if exists public.list_my_conversations();
create function public.list_my_conversations() returns table (conv_id uuid, conv_type text, title text, other_id uuid, other_username text, other_name text, other_avatar text, other_verified boolean, last_content text, last_at timestamptz,
  last_sender uuid, last_deleted boolean, unread bigint, created_at timestamptz, last_type text) language sql stable security definer set search_path = public as $$
  select c.id, c.type, c.title, o.id, o.username, o.display_name, o.avatar_url, o.is_verified, lm.content, lm.created_at, lm.sender_id, (lm.deleted_at is not null),
    (select count(*) from public.messages m where m.conversation_id = c.id and m.sender_id <> auth.uid() and m.deleted_at is null and m.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)), c.created_at, lm.message_type
  from public.conversations c join public.conversation_members me on me.conversation_id = c.id and me.user_id = auth.uid()
  left join public.message_reads r on r.conversation_id = c.id and r.user_id = auth.uid()
  left join lateral (select p.id, p.username, p.display_name, p.avatar_url, p.is_verified from public.conversation_members cm join public.profiles p on p.id = cm.user_id where cm.conversation_id = c.id and cm.user_id <> auth.uid() and c.type = 'direct' limit 1) o on true
  left join lateral (select m.content, m.created_at, m.sender_id, m.deleted_at, m.message_type from public.messages m where m.conversation_id = c.id order by m.created_at desc limit 1) lm on true
  order by coalesce(lm.created_at, c.created_at) desc $$;

-- 14b. Saluran: hanya admin saluran (pemilik) atau admin ORVIX yang bisa mengirim; pengguna lain mengikuti dan membaca
create table if not exists public.channels (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references public.profiles(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 3 and 40),
  description text not null default '' check (char_length(description) <= 300),
  category text not null default 'umum' check (category in ('umum','resmi','teknologi','game','musik','film','olahraga','kuliner','pendidikan','kreatif','gaya_hidup')),
  theme smallint not null default 0 check (theme between 0 and 5),
  is_official boolean not null default false,
  rank integer not null default 1000,
  followers_count integer not null default 0,
  last_post_at timestamptz,
  created_at timestamptz not null default now());
create unique index if not exists channels_name_uq on public.channels (lower(btrim(name)));
create index if not exists channels_top_idx on public.channels (followers_count desc, rank, created_at);
create table if not exists public.channel_follows (
  channel_id uuid not null references public.channels(id) on delete cascade, user_id uuid not null references public.profiles(id) on delete cascade,
  followed_at timestamptz not null default now(), last_read_at timestamptz not null default now(), primary key (channel_id, user_id));
create index if not exists channel_follows_user_idx on public.channel_follows (user_id);
create table if not exists public.channel_posts (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.channels(id) on delete cascade, author_id uuid references public.profiles(id) on delete set null,
  content text not null default '' check (char_length(content) <= 2000), media_path text, media_type text check (media_type in ('image','video')), thumb_path text,
  duration_ms integer, created_at timestamptz not null default now(), check (char_length(btrim(content)) > 0 or media_path is not null));
create index if not exists channel_posts_idx on public.channel_posts (channel_id, created_at desc);
create or replace function public.channel_follow_count() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then update public.channels set followers_count = followers_count + 1 where id = new.channel_id;
  else update public.channels set followers_count = greatest(0, followers_count - 1) where id = old.channel_id; end if;
  return null;
end $$;
drop trigger if exists trg_channel_follow_count on public.channel_follows;
create trigger trg_channel_follow_count after insert or delete on public.channel_follows for each row execute function public.channel_follow_count();
create or replace function public.channel_post_touch() returns trigger language plpgsql security definer set search_path = public as $$
begin update public.channels set last_post_at = new.created_at where id = new.channel_id; return null; end $$;
drop trigger if exists trg_channel_post_touch on public.channel_posts;
create trigger trg_channel_post_touch after insert on public.channel_posts for each row execute function public.channel_post_touch();
alter table public.channels enable row level security;
alter table public.channel_follows enable row level security;
alter table public.channel_posts enable row level security;
drop policy if exists channels_select on public.channels;
create policy channels_select on public.channels for select to authenticated using (true);
drop policy if exists channel_posts_select on public.channel_posts;
create policy channel_posts_select on public.channel_posts for select to authenticated using (true);
drop policy if exists channel_follows_select on public.channel_follows;
create policy channel_follows_select on public.channel_follows for select to authenticated using (user_id = auth.uid());
revoke all on public.channels, public.channel_follows, public.channel_posts from anon, authenticated;
grant select on public.channels, public.channel_posts, public.channel_follows to authenticated;

create or replace function public.can_post_channel(cid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select public.is_active() and exists (select 1 from public.channels c where c.id = cid and (c.owner_id = auth.uid() or public.is_admin())) $$;
create or replace function public.create_channel(p_name text, p_description text default '', p_category text default 'umum', p_theme integer default 0) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_name text := btrim(coalesce(p_name, '')); v_desc text := left(btrim(coalesce(p_description, '')), 300);
begin
  if auth.uid() is null or not public.is_active() then raise exception 'Akun tidak aktif'; end if;
  if char_length(v_name) < 3 or char_length(v_name) > 40 then raise exception 'Nama saluran harus 3-40 karakter'; end if;
  if coalesce(p_category, '') not in ('umum','teknologi','game','musik','film','olahraga','kuliner','pendidikan','kreatif','gaya_hidup') then raise exception 'Kategori tidak valid'; end if;
  if p_theme is null or p_theme not between 0 and 5 then raise exception 'Tema tidak valid'; end if;
  if not public.is_admin() and (select count(*) from public.channels where owner_id = auth.uid()) >= 3 then raise exception 'Maksimal 3 saluran per pengguna'; end if;
  insert into public.channels (owner_id, name, description, category, theme) values (auth.uid(), v_name, v_desc, p_category, p_theme) returning id into v_id;
  insert into public.channel_follows (channel_id, user_id) values (v_id, auth.uid());
  return v_id;
exception when unique_violation then raise exception 'Nama saluran sudah dipakai';
end $$;
create or replace function public.update_channel(p_id uuid, p_name text, p_description text, p_category text, p_theme integer) returns void language plpgsql security definer set search_path = public as $$
declare v_name text := btrim(coalesce(p_name, '')); v_desc text := left(btrim(coalesce(p_description, '')), 300);
begin
  if not public.can_post_channel(p_id) then raise exception 'Hanya admin saluran yang bisa mengubah saluran'; end if;
  if char_length(v_name) < 3 or char_length(v_name) > 40 then raise exception 'Nama saluran harus 3-40 karakter'; end if;
  if coalesce(p_category, '') not in ('umum','resmi','teknologi','game','musik','film','olahraga','kuliner','pendidikan','kreatif','gaya_hidup') or (p_category = 'resmi' and not public.is_admin()) then raise exception 'Kategori tidak valid'; end if;
  if p_theme is null or p_theme not between 0 and 5 then raise exception 'Tema tidak valid'; end if;
  update public.channels set name = v_name, description = v_desc, category = p_category, theme = p_theme where id = p_id;
exception when unique_violation then raise exception 'Nama saluran sudah dipakai';
end $$;
create or replace function public.delete_channel(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.can_post_channel(p_id) then raise exception 'Hanya admin saluran yang bisa menghapus saluran'; end if;
  delete from public.channels where id = p_id;
end $$;
create or replace function public.follow_channel(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.is_active() then raise exception 'Akun tidak aktif'; end if;
  if not exists (select 1 from public.channels where id = p_id) then raise exception 'Saluran tidak ditemukan'; end if;
  insert into public.channel_follows (channel_id, user_id) values (p_id, auth.uid()) on conflict do nothing;
end $$;
create or replace function public.unfollow_channel(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
begin delete from public.channel_follows where channel_id = p_id and user_id = auth.uid(); end $$;
create or replace function public.mark_channel_read(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
begin update public.channel_follows set last_read_at = now() where channel_id = p_id and user_id = auth.uid(); end $$;
create or replace function public.post_channel(p_id uuid, p_content text default '', p_media_path text default null, p_media_type text default null, p_thumb_path text default null, p_duration_ms integer default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_c text := btrim(coalesce(p_content, ''));
begin
  if not public.can_post_channel(p_id) then raise exception 'Hanya admin saluran yang bisa mengirim pesan'; end if;
  if char_length(v_c) > 2000 then raise exception 'Pesan terlalu panjang (maks. 2000 karakter)'; end if;
  if p_media_path is null then
    if v_c = '' then raise exception 'Pesan tidak boleh kosong'; end if;
    p_media_type := null; p_thumb_path := null; p_duration_ms := null;
  else
    if coalesce(p_media_type, '') not in ('image','video') then raise exception 'Jenis media tidak valid'; end if;
    if p_media_path not like p_id::text || '/%' or (p_thumb_path is not null and p_thumb_path not like p_id::text || '/%') then raise exception 'Lokasi berkas tidak valid'; end if;
  end if;
  insert into public.channel_posts (channel_id, author_id, content, media_path, media_type, thumb_path, duration_ms) values (p_id, auth.uid(), v_c, p_media_path, p_media_type, p_thumb_path, p_duration_ms) returning id into v_id;
  return v_id;
end $$;
create or replace function public.delete_channel_post(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
declare v_ch uuid;
begin
  select channel_id into v_ch from public.channel_posts where id = p_id;
  if not found then raise exception 'Pesan tidak ditemukan'; end if;
  if not public.can_post_channel(v_ch) then raise exception 'Akses ditolak'; end if;
  delete from public.channel_posts where id = p_id;
end $$;
create or replace function public.my_channels() returns table (id uuid, name text, description text, category text, theme smallint, is_official boolean, owner_id uuid, followers_count integer, last_post_at timestamptz,
  last_content text, last_type text, unread bigint, is_owner boolean, can_post boolean, following boolean) language sql stable security definer set search_path = public as $$
  select c.id, c.name, c.description, c.category, c.theme, c.is_official, c.owner_id, c.followers_count, c.last_post_at, lp.content, lp.media_type,
    (select count(*) from public.channel_posts p where p.channel_id = c.id and p.created_at > f.last_read_at and p.author_id is distinct from auth.uid()), (c.owner_id = auth.uid()), public.can_post_channel(c.id), true
  from public.channel_follows f join public.channels c on c.id = f.channel_id
  left join lateral (select p.content, p.media_type from public.channel_posts p where p.channel_id = c.id order by p.created_at desc limit 1) lp on true
  where f.user_id = auth.uid() order by coalesce(c.last_post_at, f.followed_at) desc $$;
create or replace function public.discover_channels(p_q text default '', p_limit integer default 12, p_offset integer default 0)
returns table (id uuid, name text, description text, category text, theme smallint, is_official boolean, owner_id uuid, followers_count integer, last_post_at timestamptz,
  last_content text, last_type text, unread bigint, is_owner boolean, can_post boolean, following boolean) language sql stable security definer set search_path = public as $$
  select c.id, c.name, c.description, c.category, c.theme, c.is_official, c.owner_id, c.followers_count, c.last_post_at, lp.content, lp.media_type, 0::bigint, (c.owner_id = auth.uid()), public.can_post_channel(c.id),
    exists (select 1 from public.channel_follows f where f.channel_id = c.id and f.user_id = auth.uid())
  from public.channels c left join lateral (select p.content, p.media_type from public.channel_posts p where p.channel_id = c.id order by p.created_at desc limit 1) lp on true
  where btrim(coalesce(p_q, '')) = '' or c.name ilike '%' || replace(replace(btrim(p_q), '%', ''), '_', '\_') || '%'
  order by c.followers_count desc, c.rank asc, c.created_at asc offset greatest(0, p_offset) limit least(50, greatest(1, p_limit)) $$;
revoke execute on function public.path_uuid(text), public.can_post_channel(uuid), public.create_channel(text, text, text, integer), public.update_channel(uuid, text, text, text, integer), public.delete_channel(uuid),
  public.follow_channel(uuid), public.unfollow_channel(uuid), public.mark_channel_read(uuid), public.post_channel(uuid, text, text, text, text, integer), public.delete_channel_post(uuid), public.my_channels(),
  public.discover_channels(text, integer, integer), public.list_my_conversations(), public.channel_follow_count(), public.channel_post_touch() from public, anon, authenticated;
grant execute on function public.path_uuid(text), public.can_post_channel(uuid), public.create_channel(text, text, text, integer), public.update_channel(uuid, text, text, text, integer), public.delete_channel(uuid),
  public.follow_channel(uuid), public.unfollow_channel(uuid), public.mark_channel_read(uuid), public.post_channel(uuid, text, text, text, text, integer), public.delete_channel_post(uuid), public.my_channels(),
  public.discover_channels(text, integer, integer), public.list_my_conversations() to authenticated;
-- Bucket media saluran (publik: saluran bersifat terbuka). Hanya admin saluran yang bisa mengunggah/menghapus.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values ('channel-media', 'channel-media', true, 26214400, array['image/jpeg','image/png','image/webp','video/mp4','video/webm','video/quicktime'])
  on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists channel_media_select on storage.objects;
create policy channel_media_select on storage.objects for select to authenticated using (bucket_id = 'channel-media');
drop policy if exists channel_media_insert on storage.objects;
create policy channel_media_insert on storage.objects for insert to authenticated with check (bucket_id = 'channel-media' and public.can_post_channel(public.path_uuid(name)));
drop policy if exists channel_media_delete on storage.objects;
create policy channel_media_delete on storage.objects for delete to authenticated using (bucket_id = 'channel-media' and public.can_post_channel(public.path_uuid(name)));
do $$ begin
  begin alter publication supabase_realtime add table public.channel_posts; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.channel_follows; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.channels; exception when duplicate_object then null; end;
end $$;
-- 14c. 12 saluran resmi ORVIX sebagai rekomendasi awal (urutan teratas mengikuti jumlah pengikut, lalu urutan ini). Aman dijalankan ulang.
with seed (name, description, category, theme, rank, intro) as (values
  ('ORVIX Resmi', 'Pengumuman resmi, fitur baru, dan kabar terbaru dari tim ORVIX.', 'resmi', 0, 1, 'Admin membagikan pengumuman, fitur baru, dan informasi penting seputar layanan ORVIX.'),
  ('Tips dan Trik ORVIX', 'Cara memakai ORVIX lebih cepat: chat, story, saluran, dan privasi.', 'resmi', 1, 2, 'Panduan singkat memakai ORVIX, dari menambah teman lewat ID ORVIX sampai mengatur siapa yang bisa melihat story kamu.'),
  ('Teknologi dan Gadget', 'Info seputar teknologi, aplikasi, dan gadget.', 'teknologi', 2, 3, 'Kabar dan ulasan singkat seputar teknologi, aplikasi, dan gadget.'),
  ('Game dan Esports', 'Tempat berkumpul pecinta game dan esports.', 'game', 3, 4, 'Info game, turnamen, dan obrolan seputar esports.'),
  ('Musik Santai', 'Rekomendasi musik untuk menemani harimu.', 'musik', 4, 5, 'Rekomendasi lagu dan artis untuk menemani aktivitasmu.'),
  ('Film dan Serial', 'Rekomendasi dan obrolan film serta serial.', 'film', 5, 6, 'Rekomendasi tontonan dan ulasan singkat film serta serial.'),
  ('Olahraga Hari Ini', 'Kabar dan obrolan seputar olahraga.', 'olahraga', 0, 7, 'Kabar olahraga, jadwal pertandingan, dan tips berolahraga.'),
  ('Kuliner Nusantara', 'Resep dan rekomendasi makanan khas Indonesia.', 'kuliner', 1, 8, 'Resep, tempat makan, dan cerita kuliner dari seluruh Nusantara.'),
  ('Belajar Bahasa Inggris', 'Tips dan latihan bahasa Inggris setiap hari.', 'pendidikan', 2, 9, 'Kosakata, tata bahasa, dan latihan singkat untuk belajar bahasa Inggris.'),
  ('Desain dan Kreatif', 'Inspirasi desain, ilustrasi, dan karya kreatif.', 'kreatif', 3, 10, 'Inspirasi desain, ilustrasi, dan tips berkarya.'),
  ('Motivasi Harian', 'Kata penyemangat untuk memulai hari.', 'gaya_hidup', 4, 11, 'Kata-kata penyemangat dan pengingat positif setiap hari.'),
  ('Kesehatan dan Gaya Hidup', 'Tips hidup sehat dan seimbang.', 'gaya_hidup', 5, 12, 'Tips menjaga kesehatan, pola makan, tidur, dan keseimbangan hidup.')),
ins as (insert into public.channels (name, description, category, theme, is_official, rank) select name, description, category, theme, true, rank from seed on conflict ((lower(btrim(name)))) do nothing returning id, name)
insert into public.channel_posts (channel_id, author_id, content) select ins.id, null, 'Selamat datang di ' || ins.name || '. ' || seed.intro from ins join seed on seed.name = ins.name;
