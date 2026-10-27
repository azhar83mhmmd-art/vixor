-- ORVIX fitur baru, BAGIAN 1/9: bersihkan fungsi lama + kolom media pesan
do $$ declare r record; begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('create_channel','follow_channel','unfollow_channel','list_my_channels',
      'discover_channels','get_invite_code','invite_preview','join_by_invite','seed_official_channels','new_invite_code','set_invite_code')
  loop execute 'drop function if exists ' || r.sig || ' cascade'; end loop;
end $$;

alter table public.messages add column if not exists media_path text;
alter table public.messages add column if not exists media_type text;
alter table public.messages drop constraint if exists messages_media_type_check;
alter table public.messages add constraint messages_media_type_check check (media_type is null or media_type in ('image','video'));
alter table public.messages drop constraint if exists messages_message_type_check;
alter table public.messages add constraint messages_message_type_check check (message_type in ('text','image','video'));
grant insert (conversation_id, sender_id, content, message_type, media_path, media_type) on public.messages to authenticated;
-- ORVIX fitur baru, BAGIAN 2/9: kolom grup & saluran + kode undangan
alter table public.conversations drop constraint if exists conversations_type_check;
alter table public.conversations add constraint conversations_type_check check (type in ('direct','group','channel'));
alter table public.conversations drop constraint if exists conversations_check;
alter table public.conversations drop constraint if exists conversations_kind_check;
alter table public.conversations add constraint conversations_kind_check
  check ((type = 'direct' and direct_key is not null) or (type <> 'direct' and direct_key is null));
alter table public.conversations add column if not exists description text;
alter table public.conversations drop constraint if exists conversations_description_check;
alter table public.conversations add constraint conversations_description_check check (description is null or char_length(description) <= 300);
alter table public.conversations add column if not exists is_public boolean not null default false;
alter table public.conversations add column if not exists is_official boolean not null default false;
alter table public.conversations add column if not exists invite_code text;
alter table public.conversations add column if not exists slug text;
create unique index if not exists conversations_invite_code_uq on public.conversations (invite_code);
create unique index if not exists conversations_slug_uq on public.conversations (slug);

create or replace function public.new_invite_code() returns text
language sql volatile set search_path = public as $$
  select substr(replace(gen_random_uuid()::text, '-', ''), 1, 16) $$;

create or replace function public.set_invite_code() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.type <> 'direct' and new.invite_code is null then new.invite_code := public.new_invite_code(); end if;
  return new;
end $$;

drop trigger if exists trg_conv_invite on public.conversations;
create trigger trg_conv_invite before insert on public.conversations
  for each row execute function public.set_invite_code();

update public.conversations set invite_code = public.new_invite_code()
  where invite_code is null and type <> 'direct';
-- ORVIX fitur baru, BAGIAN 3/9: hanya pemilik yang boleh kirim di saluran + policy kirim pesan
create or replace function public.can_send(conv uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_member(conv)
    and exists (select 1 from public.profiles where id = auth.uid() and not is_suspended)
    and (not exists (select 1 from public.conversations c where c.id = conv and c.type = 'channel')
         or exists (select 1 from public.conversation_members m
                    where m.conversation_id = conv and m.user_id = auth.uid() and m.role = 'owner'))
    and not exists (
      select 1 from public.conversations c
      join public.conversation_members m on m.conversation_id = c.id and m.user_id <> auth.uid()
      where c.id = conv and c.type = 'direct' and public.is_blocked_between(auth.uid(), m.user_id))
$$;

drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and public.can_send(conversation_id)
    and (
      (message_type = 'text' and media_path is null and media_type is null
        and char_length(btrim(content)) between 1 and 4000)
      or
      (message_type in ('image','video') and media_type = message_type
        and char_length(content) <= 4000
        and media_path like conversation_id::text || '/' || auth.uid()::text || '/%')
    ));
-- ORVIX fitur baru, BAGIAN 4/9: bucket chat-media (privat, 25 MB)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('chat-media', 'chat-media', false, 26214400,
   array['image/jpeg','image/png','image/webp','video/mp4','video/webm','video/quicktime'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types, public = false;

drop policy if exists chatmedia_select on storage.objects;
create policy chatmedia_select on storage.objects for select to authenticated
  using (bucket_id = 'chat-media' and public.is_member(((storage.foldername(name))[1])::uuid));

drop policy if exists chatmedia_insert on storage.objects;
create policy chatmedia_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'chat-media' and (storage.foldername(name))[2] = auth.uid()::text
              and public.can_send(((storage.foldername(name))[1])::uuid));

drop policy if exists chatmedia_delete on storage.objects;
create policy chatmedia_delete on storage.objects for delete to authenticated
  using (bucket_id = 'chat-media' and (storage.foldername(name))[2] = auth.uid()::text);
-- ORVIX fitur baru, BAGIAN 5/9: buat, ikuti, berhenti ikuti saluran
create or replace function public.create_channel(p_name text, p_desc text, p_public boolean) returns uuid
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); cid uuid;
begin
  if me is null or not exists (select 1 from public.profiles where id = me and not is_suspended) then
    raise exception 'Belum login'; end if;
  if char_length(btrim(coalesce(p_name,''))) not between 1 and 60 then
    raise exception 'Nama saluran 1-60 karakter'; end if;
  if (select count(*) from public.conversations where created_by = me and type = 'channel') >= 10 then
    raise exception 'Maksimal 10 saluran per akun'; end if;
  insert into public.conversations (type, title, description, is_public, created_by, invite_code)
    values ('channel', btrim(p_name), nullif(left(btrim(coalesce(p_desc,'')), 300), ''),
            coalesce(p_public, true), me, public.new_invite_code())
    returning id into cid;
  insert into public.conversation_members (conversation_id, user_id, role) values (cid, me, 'owner');
  return cid;
end $$;

create or replace function public.follow_channel(conv uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Belum login'; end if;
  if not exists (select 1 from public.conversations where id = conv and type = 'channel' and is_public) then
    raise exception 'Saluran tidak ditemukan'; end if;
  insert into public.conversation_members (conversation_id, user_id) values (conv, auth.uid()) on conflict do nothing;
end $$;

create or replace function public.unfollow_channel(conv uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.conversation_members
             where conversation_id = conv and user_id = auth.uid() and role = 'owner') then
    raise exception 'Pemilik tidak bisa berhenti mengikuti saluran sendiri'; end if;
  delete from public.conversation_members m using public.conversations c
    where m.conversation_id = conv and m.user_id = auth.uid()
      and c.id = m.conversation_id and c.type = 'channel';
end $$;
-- ORVIX fitur baru, BAGIAN 6/9: daftar saluran saya + rekomendasi
create or replace function public.list_my_channels()
returns table (conv_id uuid, title text, description text, is_official boolean, is_owner boolean, followers bigint,
               last_content text, last_at timestamptz, last_media text, unread bigint, invite_code text)
language sql stable security definer set search_path = public as $$
  select c.id, c.title, c.description, c.is_official, (me.role = 'owner'),
    (select count(*) from public.conversation_members x where x.conversation_id = c.id),
    lm.content, coalesce(lm.created_at, c.created_at), lm.media_type,
    (select count(*) from public.messages m
       where m.conversation_id = c.id and m.sender_id <> auth.uid() and m.deleted_at is null
         and m.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)),
    c.invite_code
  from public.conversations c
  join public.conversation_members me on me.conversation_id = c.id and me.user_id = auth.uid()
  left join public.message_reads r on r.conversation_id = c.id and r.user_id = auth.uid()
  left join lateral (select m.content, m.created_at, m.media_type from public.messages m
    where m.conversation_id = c.id and m.deleted_at is null order by m.created_at desc limit 1) lm on true
  where c.type = 'channel'
  order by coalesce(lm.created_at, c.created_at) desc
$$;

create or replace function public.discover_channels(lim int default 20)
returns table (conv_id uuid, title text, description text, is_official boolean, followers bigint, following boolean)
language sql stable security definer set search_path = public as $$
  select t.id, t.title, t.description, t.is_official, t.f,
    exists (select 1 from public.conversation_members x where x.conversation_id = t.id and x.user_id = auth.uid())
  from (
    select c.id, c.title, c.description, c.is_official, c.created_at,
      (select count(*) from public.conversation_members x where x.conversation_id = c.id) as f
    from public.conversations c where c.type = 'channel' and c.is_public
  ) t
  order by t.f desc, t.is_official desc, t.created_at asc
  limit least(greatest(lim, 1), 50)
$$;
-- ORVIX fitur baru, BAGIAN 7/9: link undangan grup & saluran
create or replace function public.get_invite_code(conv uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v_code text;
begin
  if not public.is_member(conv) then raise exception 'Bukan anggota'; end if;
  select c.invite_code into v_code from public.conversations c where c.id = conv and c.type <> 'direct';
  if v_code is null then raise exception 'Percakapan ini tidak punya link'; end if;
  return v_code;
end $$;

create or replace function public.invite_preview(code text)
returns table (conv_id uuid, kind text, title text, description text, is_official boolean, members bigint, joined boolean)
language sql stable security definer set search_path = public as $$
  select c.id, c.type, c.title, c.description, c.is_official,
    (select count(*) from public.conversation_members x where x.conversation_id = c.id),
    (auth.uid() is not null and exists (select 1 from public.conversation_members x
       where x.conversation_id = c.id and x.user_id = auth.uid()))
  from public.conversations c where c.invite_code = btrim(code) and c.type <> 'direct'
$$;

create or replace function public.join_by_invite(code text) returns table (conv_id uuid, kind text)
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_type text;
begin
  if auth.uid() is null or not exists (select 1 from public.profiles where id = auth.uid() and not is_suspended) then
    raise exception 'Belum login'; end if;
  select c.id, c.type into v_id, v_type from public.conversations c
    where c.invite_code = btrim(code) and c.type <> 'direct';
  if v_id is null then raise exception 'Link tidak valid atau sudah tidak berlaku'; end if;
  if v_type = 'group' and (select count(*) from public.conversation_members x where x.conversation_id = v_id) >= 50 then
    raise exception 'Grup sudah penuh (maks. 50 anggota)'; end if;
  insert into public.conversation_members (conversation_id, user_id) values (v_id, auth.uid()) on conflict do nothing;
  return query select v_id, v_type;
end $$;
-- ORVIX fitur baru, BAGIAN 8/9: izin eksekusi fungsi
revoke execute on function public.new_invite_code(), public.set_invite_code() from public, anon, authenticated;

revoke execute on function public.create_channel(text, text, boolean), public.follow_channel(uuid),
  public.unfollow_channel(uuid), public.list_my_channels(), public.discover_channels(int),
  public.get_invite_code(uuid), public.join_by_invite(text)
  from public, anon;
grant execute on function public.create_channel(text, text, boolean), public.follow_channel(uuid),
  public.unfollow_channel(uuid), public.list_my_channels(), public.discover_channels(int),
  public.get_invite_code(uuid), public.join_by_invite(text)
  to authenticated;

grant execute on function public.invite_preview(text) to anon, authenticated;
-- ORVIX BAGIAN 9/9: saluran rekomendasi HANYA dari pengguna + real-time
-- Aman dijalankan di database baru maupun yang sudah menjalankan bagian lama.

-- 1) Hapus 12 saluran resmi bawaan dan fungsi pengisinya
delete from public.conversations where type = 'channel' and is_official = true;
drop function if exists public.seed_official_channels() cascade;

-- 2) Saluran publik boleh dilihat semua pengguna login (agar muncul real-time)
drop policy if exists conv_select_public on public.conversations;
create policy conv_select_public on public.conversations for select to authenticated
  using (type = 'channel' and is_public);

do $$ begin
  alter publication supabase_realtime add table public.conversations;
exception when duplicate_object then null; end $$;

-- 3) Rekomendasi: saluran publik buatan pengguna, pengikut terbanyak lalu terbaru
drop function if exists public.discover_channels(int);
create function public.discover_channels(lim int default 20)
returns table (conv_id uuid, title text, description text, is_official boolean,
               followers bigint, following boolean, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select t.id, t.title, t.description, t.is_official, t.f,
    exists (select 1 from public.conversation_members x where x.conversation_id = t.id and x.user_id = auth.uid()),
    t.created_at
  from (
    select c.id, c.title, c.description, c.is_official, c.created_at,
      (select count(*) from public.conversation_members x where x.conversation_id = c.id) as f
    from public.conversations c where c.type = 'channel' and c.is_public
  ) t
  order by t.f desc, t.created_at desc
  limit least(greatest(lim, 1), 50)
$$;
revoke execute on function public.discover_channels(int) from public, anon;
grant execute on function public.discover_channels(int) to authenticated;
-- ORVIX BAGIAN 10: profil saluran (gaya WhatsApp), ubah & hapus saluran oleh pemilik
-- Nama fungsi diawali orvix_ agar tidak bentrok dengan fungsi lain di database ini.
do $$ declare r record; begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('orvix_channel_profile','orvix_update_channel','orvix_delete_channel')
  loop execute 'drop function if exists ' || r.sig || ' cascade'; end loop;
end $$;

create or replace function public.orvix_channel_profile(conv uuid)
returns table (conv_id uuid, title text, description text, is_official boolean, is_public boolean,
               followers bigint, following boolean, is_owner boolean, created_at timestamptz,
               owner_name text, owner_username text, owner_verified boolean,
               posts bigint, media bigint, last_post_at timestamptz)
language sql stable security definer set search_path = public as $$
  select c.id, c.title, c.description, c.is_official, c.is_public,
    (select count(*) from public.conversation_members x where x.conversation_id = c.id),
    exists (select 1 from public.conversation_members x where x.conversation_id = c.id and x.user_id = auth.uid()),
    exists (select 1 from public.conversation_members x where x.conversation_id = c.id and x.user_id = auth.uid() and x.role = 'owner'),
    c.created_at, o.display_name, o.username, coalesce(o.is_verified, false),
    (select count(*) from public.messages m where m.conversation_id = c.id and m.deleted_at is null),
    (select count(*) from public.messages m where m.conversation_id = c.id and m.deleted_at is null and m.media_path is not null),
    (select max(m.created_at) from public.messages m where m.conversation_id = c.id and m.deleted_at is null)
  from public.conversations c
  left join public.profiles o on o.id = c.created_by
  where c.id = conv and c.type = 'channel' and (c.is_public or public.is_member(c.id))
$$;

create or replace function public.orvix_update_channel(p_conv uuid, p_name text, p_desc text, p_public boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.conversation_members m join public.conversations c on c.id = m.conversation_id
      where m.conversation_id = p_conv and m.user_id = auth.uid() and m.role = 'owner' and c.type = 'channel') then
    raise exception 'Hanya pemilik saluran yang bisa mengubah'; end if;
  if char_length(btrim(coalesce(p_name,''))) not between 1 and 60 then
    raise exception 'Nama saluran 1-60 karakter'; end if;
  update public.conversations
    set title = btrim(p_name), description = nullif(left(btrim(coalesce(p_desc,'')), 300), ''),
        is_public = coalesce(p_public, is_public)
    where id = p_conv;
end $$;

create or replace function public.orvix_delete_channel(p_conv uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.conversation_members m join public.conversations c on c.id = m.conversation_id
      where m.conversation_id = p_conv and m.user_id = auth.uid() and m.role = 'owner' and c.type = 'channel') then
    raise exception 'Hanya pemilik saluran yang bisa menghapus'; end if;
  delete from public.conversations where id = p_conv;
end $$;

revoke execute on function public.orvix_channel_profile(uuid), public.orvix_update_channel(uuid, text, text, boolean),
  public.orvix_delete_channel(uuid) from public, anon;
grant execute on function public.orvix_channel_profile(uuid), public.orvix_update_channel(uuid, text, text, boolean),
  public.orvix_delete_channel(uuid) to authenticated;
-- ORVIX BAGIAN 11a: kolom foto saluran + fungsi pasang/hapus foto (khusus pemilik)
alter table public.conversations add column if not exists avatar_url text;

create or replace function public.orvix_set_channel_avatar(p_conv uuid, p_url text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.conversation_members m join public.conversations c on c.id = m.conversation_id
      where m.conversation_id = p_conv and m.user_id = auth.uid() and m.role = 'owner' and c.type = 'channel') then
    raise exception 'Hanya pemilik saluran yang bisa mengubah foto'; end if;
  if p_url is not null and (char_length(p_url) > 500
      or p_url not like ('%/storage/v1/object/public/avatars/' || auth.uid()::text || '/%')) then
    raise exception 'Alamat foto tidak valid'; end if;
  update public.conversations set avatar_url = p_url where id = p_conv;
end $$;

revoke execute on function public.orvix_set_channel_avatar(uuid, text) from public, anon;
grant execute on function public.orvix_set_channel_avatar(uuid, text) to authenticated;
-- ORVIX BAGIAN 11b: profil saluran + foto
drop function if exists public.orvix_channel_profile(uuid);
create function public.orvix_channel_profile(conv uuid)
returns table (conv_id uuid, title text, description text, is_official boolean, is_public boolean,
               followers bigint, following boolean, is_owner boolean, created_at timestamptz,
               owner_name text, owner_username text, owner_verified boolean,
               posts bigint, media bigint, last_post_at timestamptz, avatar_url text)
language sql stable security definer set search_path = public as $$
  select c.id, c.title, c.description, c.is_official, c.is_public,
    (select count(*) from public.conversation_members x where x.conversation_id = c.id),
    exists (select 1 from public.conversation_members x where x.conversation_id = c.id and x.user_id = auth.uid()),
    exists (select 1 from public.conversation_members x where x.conversation_id = c.id and x.user_id = auth.uid() and x.role = 'owner'),
    c.created_at, o.display_name, o.username, coalesce(o.is_verified, false),
    (select count(*) from public.messages m where m.conversation_id = c.id and m.deleted_at is null),
    (select count(*) from public.messages m where m.conversation_id = c.id and m.deleted_at is null and m.media_path is not null),
    (select max(m.created_at) from public.messages m where m.conversation_id = c.id and m.deleted_at is null),
    c.avatar_url
  from public.conversations c
  left join public.profiles o on o.id = c.created_by
  where c.id = conv and c.type = 'channel' and (c.is_public or public.is_member(c.id))
$$;
revoke execute on function public.orvix_channel_profile(uuid) from public, anon;
grant execute on function public.orvix_channel_profile(uuid) to authenticated;
-- ORVIX BAGIAN 11c: daftar saluran + rekomendasi, kini membawa foto saluran
drop function if exists public.list_my_channels();
create function public.list_my_channels()
returns table (conv_id uuid, title text, description text, is_official boolean, is_owner boolean, followers bigint,
               last_content text, last_at timestamptz, last_media text, unread bigint, invite_code text, avatar_url text)
language sql stable security definer set search_path = public as $$
  select c.id, c.title, c.description, c.is_official, (me.role = 'owner'),
    (select count(*) from public.conversation_members x where x.conversation_id = c.id),
    lm.content, coalesce(lm.created_at, c.created_at), lm.media_type,
    (select count(*) from public.messages m
       where m.conversation_id = c.id and m.sender_id <> auth.uid() and m.deleted_at is null
         and m.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)),
    c.invite_code, c.avatar_url
  from public.conversations c
  join public.conversation_members me on me.conversation_id = c.id and me.user_id = auth.uid()
  left join public.message_reads r on r.conversation_id = c.id and r.user_id = auth.uid()
  left join lateral (select m.content, m.created_at, m.media_type from public.messages m
    where m.conversation_id = c.id and m.deleted_at is null order by m.created_at desc limit 1) lm on true
  where c.type = 'channel'
  order by coalesce(lm.created_at, c.created_at) desc
$$;

drop function if exists public.discover_channels(int);
create function public.discover_channels(lim int default 20)
returns table (conv_id uuid, title text, description text, is_official boolean,
               followers bigint, following boolean, created_at timestamptz, avatar_url text)
language sql stable security definer set search_path = public as $$
  select t.id, t.title, t.description, t.is_official, t.f,
    exists (select 1 from public.conversation_members x where x.conversation_id = t.id and x.user_id = auth.uid()),
    t.created_at, t.avatar_url
  from (
    select c.id, c.title, c.description, c.is_official, c.created_at, c.avatar_url,
      (select count(*) from public.conversation_members x where x.conversation_id = c.id) as f
    from public.conversations c where c.type = 'channel' and c.is_public
  ) t
  order by t.f desc, t.created_at desc
  limit least(greatest(lim, 1), 50)
$$;

revoke execute on function public.list_my_channels(), public.discover_channels(int) from public, anon;
grant execute on function public.list_my_channels(), public.discover_channels(int) to authenticated;
