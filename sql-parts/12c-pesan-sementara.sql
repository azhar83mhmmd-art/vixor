-- ORVIX BAGIAN 12c: pesan sementara (Nonaktif, 24 jam, 7 hari, 90 hari)
-- Aturan: pengaturan hanya berlaku untuk PESAN BARU setelah diubah. Pesan lama tidak berubah.
-- Chat pribadi: kedua anggota boleh mengubah. Grup/saluran: hanya pemilik. Anggota diberi tahu lewat pesan sistem.

alter table public.conversations add column if not exists disappear_secs integer;
alter table public.conversations drop constraint if exists conversations_disappear_check;
alter table public.conversations add constraint conversations_disappear_check
  check (disappear_secs is null or disappear_secs in (86400, 604800, 7776000));
alter table public.conversations add column if not exists disappear_changed_at timestamptz;
alter table public.conversations add column if not exists disappear_changed_by uuid references public.profiles(id) on delete set null;

alter table public.messages add column if not exists expires_at timestamptz;
create index if not exists messages_expires_idx on public.messages (expires_at) where expires_at is not null;
create index if not exists messages_media_path_idx on public.messages (media_path) where media_path is not null;

-- Jenis pesan 'system' (pemberitahuan pengaturan); hanya dibuat oleh fungsi database
alter table public.messages drop constraint if exists messages_message_type_check;
alter table public.messages add constraint messages_message_type_check check (message_type in ('text','image','video','system'));

-- expires_at diisi server saat pesan dibuat (klien tidak punya hak menulis kolom ini)
create or replace function public.orvix_msg_expiry() returns trigger
language plpgsql security definer set search_path = public as $$
declare d integer;
begin
  if new.message_type = 'system' then new.expires_at := null; return new; end if;
  select c.disappear_secs into d from public.conversations c where c.id = new.conversation_id;
  if d is not null then new.expires_at := coalesce(new.created_at, now()) + make_interval(secs => d); end if;
  return new;
end $$;
drop trigger if exists trg_orvix_msg_expiry on public.messages;
create trigger trg_orvix_msg_expiry before insert on public.messages
  for each row execute function public.orvix_msg_expiry();

-- Pesan kedaluwarsa tidak lagi bisa dibaca lewat RLS (bukan sekadar disembunyikan di frontend)
drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages for select to authenticated
  using (public.is_member(conversation_id) and (expires_at is null or expires_at > now()));

-- Pelindung pesan: versi asli + pesan sistem tidak bisa diedit/dihapus pengguna
create or replace function public.messages_guard() returns trigger
language plpgsql as $$
begin
  if auth.uid() is null then return new; end if;   -- service role / SQL editor
  if old.message_type = 'system' then raise exception 'Pesan sistem tidak dapat diubah'; end if;
  if new.conversation_id <> old.conversation_id or new.sender_id <> old.sender_id
     or new.created_at <> old.created_at or new.message_type <> old.message_type then
    raise exception 'Kolom pesan ini tidak dapat diubah';
  end if;
  if old.deleted_at is not null then raise exception 'Pesan sudah dihapus'; end if;
  if new.deleted_at is not null then
    new.deleted_at := now(); new.content := '';
  elsif new.content is distinct from old.content then
    if now() - old.created_at > interval '15 minutes' then raise exception 'Batas waktu edit pesan 15 menit'; end if;
    if char_length(btrim(new.content)) < 1 then raise exception 'Pesan tidak boleh kosong'; end if;
    new.edited_at := now();
  end if;
  return new;
end $$;

-- Mengubah durasi (0 = nonaktif)
create or replace function public.orvix_set_disappearing(conv uuid, secs integer) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); c public.conversations; v integer := nullif(secs, 0); label text;
begin
  if me is null then raise exception 'Belum login'; end if;
  if v is not null and v not in (86400, 604800, 7776000) then raise exception 'Durasi tidak valid'; end if;
  select * into c from public.conversations where id = conv;
  if not found or not public.is_member(conv) then raise exception 'Percakapan tidak ditemukan'; end if;
  if c.type = 'direct' then
    if public.is_blocked_between(me, (select user_id from public.conversation_members where conversation_id = conv and user_id <> me limit 1)) then
      raise exception 'Tidak dapat mengubah pengaturan'; end if;
  elsif not exists (select 1 from public.conversation_members where conversation_id = conv and user_id = me and role = 'owner') then
    raise exception 'Hanya pemilik yang dapat mengubah pesan sementara';
  end if;
  if c.disappear_secs is not distinct from v then return; end if;
  update public.conversations set disappear_secs = v, disappear_changed_at = now(), disappear_changed_by = me where id = conv;
  label := case v when 86400 then '24 jam' when 604800 then '7 hari' when 7776000 then '90 hari' end;
  insert into public.messages (conversation_id, sender_id, content, message_type)
    values (conv, me, case when v is null then 'menonaktifkan pesan sementara.'
                           else 'mengaktifkan pesan sementara (' || label || '). Hanya berlaku untuk pesan baru.' end, 'system');
end $$;

-- Daftar chat: abaikan pesan kedaluwarsa dan pesan sistem pada pratinjau & hitungan belum dibaca
drop function if exists public.list_my_conversations();
create function public.list_my_conversations()
returns table (conv_id uuid, conv_type text, title text, other_id uuid, other_username text, other_name text,
               other_avatar text, other_verified boolean, last_content text, last_at timestamptz,
               last_sender uuid, last_deleted boolean, unread bigint, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select c.id, c.type, c.title, o.id, o.username, o.display_name, o.avatar_url, o.is_verified,
         lm.content, lm.created_at, lm.sender_id, (lm.deleted_at is not null),
         (select count(*) from public.messages m where m.conversation_id = c.id and m.sender_id <> auth.uid()
            and m.deleted_at is null and m.message_type <> 'system' and (m.expires_at is null or m.expires_at > now())
            and m.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)),
         c.created_at
  from public.conversations c
  join public.conversation_members me on me.conversation_id = c.id and me.user_id = auth.uid()
  left join public.message_reads r on r.conversation_id = c.id and r.user_id = auth.uid()
  left join lateral (
    select p.id, p.username, p.display_name, p.avatar_url, p.is_verified
    from public.conversation_members cm join public.profiles p on p.id = cm.user_id
    where cm.conversation_id = c.id and cm.user_id <> auth.uid() and c.type = 'direct' limit 1) o on true
  left join lateral (
    select m.content, m.created_at, m.sender_id, m.deleted_at from public.messages m
    where m.conversation_id = c.id and m.message_type <> 'system' and (m.expires_at is null or m.expires_at > now())
    order by m.created_at desc limit 1) lm on true
  order by coalesce(lm.created_at, c.created_at) desc
$$;

-- Berkas lampiran kedaluwarsa tidak bisa lagi diminta URL baru-nya lewat Storage
drop policy if exists chatmedia_select on storage.objects;
create policy chatmedia_select on storage.objects for select to authenticated
  using (bucket_id = 'chat-media' and public.is_member(((storage.foldername(name))[1])::uuid)
         and not exists (select 1 from public.messages m
                         where m.media_path = name and m.expires_at is not null and m.expires_at <= now()));

-- Pembersihan baris tanpa lampiran (fallback pg_cron). Lampiran dibersihkan oleh Edge Function purge-expired.
create or replace function public.orvix_purge_expired_text() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from public.messages where id in (
    select id from public.messages where expires_at <= now() and media_path is null limit 1000);
  get diagnostics n = row_count; return n;
end $$;

revoke execute on function public.orvix_msg_expiry(), public.orvix_purge_expired_text() from public, anon, authenticated;
revoke execute on function public.orvix_set_disappearing(uuid, integer), public.list_my_conversations() from public, anon;
grant execute on function public.orvix_set_disappearing(uuid, integer), public.list_my_conversations() to authenticated;
