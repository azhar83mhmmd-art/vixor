-- ORVIX BAGIAN 17a: balas pesan, pesan suara, reaksi, bintang, arsip, kunci chat, bisukan, tandai belum dibaca,
-- teruskan pesan, + diagnosa notifikasi push. Idempotent, tidak menghapus data. Jalankan SETELAH 13b, 15a, dan bagian saluran.

-- 1) Kolom pesan baru ----------------------------------------------------------------------------
alter table public.messages add column if not exists reply_to uuid references public.messages(id) on delete set null;
alter table public.messages add column if not exists forwarded boolean not null default false;
alter table public.messages add column if not exists duration_ms integer;
alter table public.messages add column if not exists wave text;
alter table public.messages add column if not exists media_path text;
alter table public.messages add column if not exists media_type text;

do $$ declare r record; begin
  for r in select conname from pg_constraint where conrelid = 'public.messages'::regclass and contype = 'c'
      and (pg_get_constraintdef(oid) ilike '%message_type%' or pg_get_constraintdef(oid) ilike '%media_type%'
           or pg_get_constraintdef(oid) ilike '%duration_ms%' or pg_get_constraintdef(oid) ilike '%wave%')
  loop execute format('alter table public.messages drop constraint %I', r.conname); end loop;
end $$;
alter table public.messages add constraint messages_message_type_check check (message_type in ('text','image','video','audio','system'));
alter table public.messages add constraint messages_media_type_check check (media_type is null or media_type in ('image','video','audio'));
alter table public.messages add constraint messages_duration_check check (duration_ms is null or duration_ms between 500 and 600000);
alter table public.messages add constraint messages_wave_check check (wave is null or char_length(wave) <= 120);
create index if not exists messages_reply_idx on public.messages (reply_to) where reply_to is not null;

grant insert (reply_to, forwarded, duration_ms, wave) on public.messages to authenticated;

-- Kebijakan kirim: teks, foto, video, dan pesan suara (audio) dengan lampiran di folder <conv>/<user>/
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated
  with check (
    sender_id = auth.uid() and public.can_send(conversation_id)
    and (
      (message_type = 'text' and media_path is null and char_length(btrim(content)) between 1 and 4000)
      or (message_type in ('image','video','audio') and media_type = message_type and char_length(content) <= 4000
          and media_path like conversation_id::text || '/' || sender_id::text || '/%')
    ));

-- Balasan hanya boleh merujuk pesan di percakapan yang sama
create or replace function public.orvix_msg_reply_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.reply_to is not null and not exists (select 1 from public.messages m where m.id = new.reply_to and m.conversation_id = new.conversation_id) then
    new.reply_to := null;
  end if;
  return new;
end $$;
drop trigger if exists trg_msg_reply_check on public.messages;
create trigger trg_msg_reply_check before insert on public.messages for each row execute function public.orvix_msg_reply_check();

-- Pelindung update pesan (hapus 1 jam, edit 15 menit / Premium 1 jam), pesan lampiran tidak bisa diedit
create or replace function public.messages_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare prem boolean;
begin
  if auth.uid() is null then return new; end if;
  if old.message_type = 'system' then raise exception 'Pesan sistem tidak dapat diubah'; end if;
  if new.conversation_id <> old.conversation_id or new.sender_id <> old.sender_id
     or new.created_at <> old.created_at or new.message_type <> old.message_type then
    raise exception 'Kolom pesan ini tidak dapat diubah';
  end if;
  if old.deleted_at is not null then raise exception 'Pesan sudah dihapus'; end if;
  if new.deleted_at is not null then
    if now() - old.created_at > interval '1 hour' then raise exception 'Pesan hanya bisa dihapus dalam 1 jam setelah dikirim'; end if;
    new.deleted_at := now(); new.content := ''; new.media_path := null; new.wave := null;
  elsif new.content is distinct from old.content then
    if old.message_type <> 'text' then raise exception 'Pesan lampiran tidak bisa diedit'; end if;
    select coalesce(premium_until > now(), false) into prem from public.profiles where id = old.sender_id;
    if now() - old.created_at > (case when prem then interval '1 hour' else interval '15 minutes' end) then
      raise exception 'Batas waktu edit pesan sudah lewat'; end if;
    if char_length(btrim(new.content)) < 1 then raise exception 'Pesan tidak boleh kosong'; end if;
    new.edited_at := now();
  end if;
  return new;
end $$;

-- 2) Bucket chat-media menerima audio ------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('chat-media', 'chat-media', false, 26214400,
   array['image/jpeg','image/png','image/webp','video/mp4','video/webm','video/quicktime',
         'audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/aac','audio/x-m4a','audio/wav'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types, public = false;

-- 3) Preferensi chat per pengguna: arsip, kunci, bisukan, tandai belum dibaca -----------------------
create table if not exists public.orvix_conv_prefs (
  user_id uuid not null references public.profiles(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  pinned_at timestamptz, cleared_at timestamptz,
  primary key (user_id, conversation_id)
);
alter table public.orvix_conv_prefs add column if not exists archived_at timestamptz;
alter table public.orvix_conv_prefs add column if not exists locked_at timestamptz;
alter table public.orvix_conv_prefs add column if not exists muted_until timestamptz;
alter table public.orvix_conv_prefs add column if not exists marked_unread boolean not null default false;
alter table public.orvix_conv_prefs enable row level security;
drop policy if exists conv_prefs_select on public.orvix_conv_prefs;
create policy conv_prefs_select on public.orvix_conv_prefs for select to authenticated using (user_id = auth.uid());
revoke all on public.orvix_conv_prefs from anon, authenticated;
grant select on public.orvix_conv_prefs to authenticated;

drop function if exists public.orvix_pref_apply(uuid[], text, timestamptz, boolean);
create function public.orvix_pref_apply(convs uuid[], col text, val timestamptz, flag boolean default null) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); c uuid;
begin
  if me is null then raise exception 'Sesi berakhir. Silakan masuk lagi.'; end if;
  foreach c in array coalesce(convs, '{}') loop
    if not exists (select 1 from public.conversation_members where conversation_id = c and user_id = me) then continue; end if;
    insert into public.orvix_conv_prefs (user_id, conversation_id) values (me, c) on conflict do nothing;
    if col = 'archived_at' then update public.orvix_conv_prefs set archived_at = val, pinned_at = case when val is not null then null else pinned_at end where user_id = me and conversation_id = c;
    elsif col = 'locked_at' then update public.orvix_conv_prefs set locked_at = val, pinned_at = case when val is not null then null else pinned_at end where user_id = me and conversation_id = c;
    elsif col = 'muted_until' then update public.orvix_conv_prefs set muted_until = val where user_id = me and conversation_id = c;
    elsif col = 'marked_unread' then update public.orvix_conv_prefs set marked_unread = coalesce(flag, false) where user_id = me and conversation_id = c;
    end if;
  end loop;
end $$;

drop function if exists public.orvix_archive_conversations(uuid[], boolean);
create function public.orvix_archive_conversations(convs uuid[], p_on boolean) returns void
language sql security definer set search_path = public as $$ select public.orvix_pref_apply(convs, 'archived_at', case when p_on then now() end) $$;
drop function if exists public.orvix_lock_conversations(uuid[], boolean);
create function public.orvix_lock_conversations(convs uuid[], p_on boolean) returns void
language sql security definer set search_path = public as $$ select public.orvix_pref_apply(convs, 'locked_at', case when p_on then now() end) $$;
-- p_until: null = bunyikan nonaktif; 'infinity' = selamanya
drop function if exists public.orvix_mute_conversations(uuid[], timestamptz);
create function public.orvix_mute_conversations(convs uuid[], p_until timestamptz) returns void
language sql security definer set search_path = public as $$ select public.orvix_pref_apply(convs, 'muted_until', p_until) $$;
drop function if exists public.orvix_mark_unread(uuid[], boolean);
create function public.orvix_mark_unread(convs uuid[], flag boolean) returns void
language sql security definer set search_path = public as $$ select public.orvix_pref_apply(convs, 'marked_unread', null, flag) $$;

-- Daftar chat lengkap (sematan, hapus chat, pesan sementara, arsip, kunci, bisukan, tandai belum dibaca)
drop function if exists public.list_my_conversations();
create function public.list_my_conversations()
returns table (conv_id uuid, conv_type text, title text, other_id uuid, other_username text, other_name text,
               other_avatar text, other_verified boolean, last_content text, last_at timestamptz,
               last_sender uuid, last_deleted boolean, unread bigint, created_at timestamptz,
               pinned boolean, cleared_at timestamptz, last_type text,
               archived boolean, locked boolean, muted_until timestamptz, marked_unread boolean)
language sql stable security definer set search_path = public as $$
  select conv_id, conv_type, title, other_id, other_username, other_name, other_avatar, other_verified, last_content, last_at,
         last_sender, last_deleted, unread, created_at, pinned, cleared_at, last_type,
         (arch_at is not null and (last_at is null or last_at <= arch_at)), (lock_at is not null), mute_until, mk_unread
  from (
    select c.id, c.type, c.title, o.id, o.username, o.display_name, o.avatar_url, o.is_verified,
           lm.content, lm.created_at, lm.sender_id, (lm.deleted_at is not null),
           (select count(*) from public.messages m where m.conversation_id = c.id and m.sender_id <> auth.uid()
              and m.deleted_at is null and m.message_type <> 'system' and (m.expires_at is null or m.expires_at > now())
              and m.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)
              and m.created_at > coalesce(pf.cleared_at, '-infinity'::timestamptz)),
           c.created_at, (pf.pinned_at is not null), pf.cleared_at, lm.message_type,
           pf.pinned_at, pf.archived_at, pf.locked_at, pf.muted_until, coalesce(pf.marked_unread, false)
    from public.conversations c
    join public.conversation_members me on me.conversation_id = c.id and me.user_id = auth.uid()
    left join public.message_reads r on r.conversation_id = c.id and r.user_id = auth.uid()
    left join public.orvix_conv_prefs pf on pf.conversation_id = c.id and pf.user_id = auth.uid()
    left join lateral (
      select p.id, p.username, p.display_name, p.avatar_url, p.is_verified
      from public.conversation_members cm join public.profiles p on p.id = cm.user_id
      where cm.conversation_id = c.id and cm.user_id <> auth.uid() and c.type = 'direct' limit 1) o on true
    left join lateral (
      select m.content, m.created_at, m.sender_id, m.deleted_at, m.message_type from public.messages m
      where m.conversation_id = c.id and m.message_type <> 'system' and (m.expires_at is null or m.expires_at > now())
        and m.created_at > coalesce(pf.cleared_at, '-infinity'::timestamptz)
      order by m.created_at desc limit 1) lm on true
    where pf.cleared_at is null or lm.created_at is not null
  ) x(conv_id, conv_type, title, other_id, other_username, other_name, other_avatar, other_verified, last_content, last_at,
      last_sender, last_deleted, unread, created_at, pinned, cleared_at, last_type, pin_at, arch_at, lock_at, mute_until, mk_unread)
  order by (pin_at is not null) desc, pin_at desc nulls last, coalesce(last_at, created_at) desc
$$;

-- 4) Reaksi emoji (satu per pengguna per pesan) ----------------------------------------------------
create table if not exists public.orvix_msg_reactions (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  emoji text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);
alter table public.orvix_msg_reactions enable row level security;
drop policy if exists react_select on public.orvix_msg_reactions;
create policy react_select on public.orvix_msg_reactions for select to authenticated
  using (exists (select 1 from public.messages m where m.id = message_id and public.is_member(m.conversation_id)));
revoke all on public.orvix_msg_reactions from anon, authenticated;
grant select on public.orvix_msg_reactions to authenticated;

drop function if exists public.orvix_msg_react(uuid, text);
create function public.orvix_msg_react(msg uuid, emo text) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); cid uuid;
begin
  if me is null then raise exception 'Sesi berakhir. Silakan masuk lagi.'; end if;
  select conversation_id into cid from public.messages where id = msg and deleted_at is null;
  if cid is null or not public.is_member(cid) then raise exception 'Pesan tidak ditemukan'; end if;
  if emo is null or btrim(emo) = '' then delete from public.orvix_msg_reactions where message_id = msg and user_id = me; return; end if;
  insert into public.orvix_msg_reactions (message_id, user_id, emoji) values (msg, me, left(emo, 16))
    on conflict (message_id, user_id) do update set emoji = excluded.emoji, created_at = now();
end $$;

-- 5) Pesan berbintang (pribadi) --------------------------------------------------------------------
create table if not exists public.orvix_msg_starred (
  user_id uuid not null references public.profiles(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, message_id)
);
alter table public.orvix_msg_starred enable row level security;
drop policy if exists starred_select on public.orvix_msg_starred;
create policy starred_select on public.orvix_msg_starred for select to authenticated using (user_id = auth.uid());
revoke all on public.orvix_msg_starred from anon, authenticated;
grant select on public.orvix_msg_starred to authenticated;

drop function if exists public.orvix_msg_star(uuid[], boolean);
create function public.orvix_msg_star(msgs uuid[], star boolean) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); m uuid;
begin
  if me is null then raise exception 'Sesi berakhir. Silakan masuk lagi.'; end if;
  foreach m in array coalesce(msgs, '{}') loop
    if star then
      insert into public.orvix_msg_starred (user_id, message_id)
        select me, id from public.messages where id = m and deleted_at is null and public.is_member(conversation_id)
        on conflict do nothing;
    else delete from public.orvix_msg_starred where user_id = me and message_id = m; end if;
  end loop;
end $$;

-- 6) Realtime untuk reaksi -------------------------------------------------------------------------
do $$ begin
  begin alter publication supabase_realtime add table public.orvix_msg_reactions; exception when duplicate_object then null; when others then raise notice 'Tambahkan orvix_msg_reactions ke publication supabase_realtime dari Dashboard.'; end;
end $$;

-- 7) NOTIFIKASI PUSH: perbaikan + diagnosa ------------------------------------------------------------
-- (a) push_configure memangkas spasi/baris baru (penyebab umum 401 "secret tidak cocok")
create or replace function public.push_configure(fn_url text, secret text) returns void
language plpgsql security definer set search_path = public as $$
declare u text := btrim(fn_url); s text := btrim(secret);
begin
  if u !~ '^https://' or char_length(s) < 24 then raise exception 'URL harus https dan secret minimal 24 karakter'; end if;
  insert into public.push_config (key, value) values ('url', u), ('secret', s)
    on conflict (key) do update set value = excluded.value;
end $$;

-- (b) Batas waktu pg_net 15 detik (cold start Edge Function + kirim ke push service bisa > 3 detik)
create or replace function public.push_post(payload jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare u text; s text;
begin
  select btrim(value) into u from public.push_config where key = 'url';
  select btrim(value) into s from public.push_config where key = 'secret';
  if u is null or s is null then return; end if;
  perform net.http_post(url := u, body := payload, headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', s), timeout_milliseconds := 15000);
exception when others then null;
end $$;

-- (c) Diagnosa: status konfigurasi + respons HTTP terakhir dari Edge Function (hanya untuk pengguna login)
drop function if exists public.push_diag();
create function public.push_diag() returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); res jsonb := '{}'::jsonb; has_net boolean; subs int; last jsonb := '[]'::jsonb; cfg_url text;
begin
  if me is null then raise exception 'Sesi berakhir. Silakan masuk lagi.'; end if;
  if not exists (select 1 from public.profiles where id = me and role = 'admin' and not is_suspended) then raise exception 'Khusus admin.'; end if;
  select value into cfg_url from public.push_config where key = 'url';
  has_net := exists (select 1 from pg_extension where extname = 'pg_net');
  select count(*) into subs from public.push_subscriptions where user_id = me;
  res := jsonb_build_object('has_url', cfg_url is not null, 'url_host', case when cfg_url is null then null else split_part(split_part(cfg_url, '//', 2), '/', 1) end,
    'has_secret', exists (select 1 from public.push_config where key = 'secret'), 'has_pg_net', has_net, 'my_subscriptions', subs,
    'trigger_message', exists (select 1 from pg_trigger where tgname = 'trg_push_message' and not tgisinternal));
  if has_net then
    begin
      execute $q$select coalesce(jsonb_agg(x), '[]'::jsonb) from (
          select status_code, left(coalesce(content, ''), 300) as body, left(coalesce(error_msg, ''), 200) as error, created
          from net._http_response order by created desc limit 4) x$q$ into last;
    exception when others then last := '[]'::jsonb; end;
  end if;
  return res || jsonb_build_object('responses', last);
end $$;

-- (d) Pesan baru: kirim push ke penerima sesuai bisu/kunci. (Trigger lama tetap dipakai.)
revoke all on function public.push_configure(text, text), public.push_post(jsonb) from public, anon, authenticated;
revoke all on function public.push_diag() from public, anon;
grant execute on function public.push_diag() to authenticated;

revoke all on function public.orvix_pref_apply(uuid[], text, timestamptz, boolean) from public, anon, authenticated;
revoke all on function public.orvix_archive_conversations(uuid[], boolean), public.orvix_lock_conversations(uuid[], boolean),
  public.orvix_mute_conversations(uuid[], timestamptz), public.orvix_mark_unread(uuid[], boolean),
  public.orvix_msg_react(uuid, text), public.orvix_msg_star(uuid[], boolean), public.list_my_conversations() from public, anon;
grant execute on function public.orvix_archive_conversations(uuid[], boolean), public.orvix_lock_conversations(uuid[], boolean),
  public.orvix_mute_conversations(uuid[], timestamptz), public.orvix_mark_unread(uuid[], boolean),
  public.orvix_msg_react(uuid, text), public.orvix_msg_star(uuid[], boolean), public.list_my_conversations() to authenticated;
