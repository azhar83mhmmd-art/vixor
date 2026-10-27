-- =====================================================================
-- ORVIX — supabase.sql  (jalankan berurutan di Supabase SQL Editor)
-- Bagian 1-3: tabel | 4: fungsi | 5: RPC | 6: RLS | 7: grants
-- 8: storage | 9: realtime | 10: izin eksekusi fungsi
-- =====================================================================

-- ---------- 1. EKSTENSI & HELPER ----------
create extension if not exists pgcrypto;

create or replace function public.set_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

-- ---------- 2. TABEL ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  orvix_id text unique not null check (orvix_id ~ '^[0-9]{8}$'),
  username text unique not null check (username ~ '^[a-z0-9_]{3,20}$'),
  display_name text not null check (char_length(display_name) between 1 and 40),
  avatar_url text,
  status_text text check (status_text is null or char_length(status_text) <= 140),
  is_verified boolean not null default false,
  verified_at timestamptz,
  is_suspended boolean not null default false,
  role text not null default 'user' check (role in ('user','admin')),
  profile_public boolean not null default true,
  show_last_seen boolean not null default true,
  story_visibility text not null default 'friends' check (story_visibility in ('friends','public','only_me')),
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists trg_profiles_updated on public.profiles;
create trigger trg_profiles_updated before update on public.profiles
  for each row execute function public.set_updated_at();

create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete cascade,
  addressee_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (requester_id <> addressee_id)
);
create unique index if not exists friendships_pair_uq
  on public.friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));
create index if not exists friendships_addressee_idx on public.friendships (addressee_id, status);
drop trigger if exists trg_friendships_updated on public.friendships;
create trigger trg_friendships_updated before update on public.friendships
  for each row execute function public.set_updated_at();

create table if not exists public.blocked_users (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('direct','group')),
  title text check (title is null or char_length(title) between 1 and 60),
  created_by uuid references public.profiles(id) on delete set null,
  direct_key text unique,
  created_at timestamptz not null default now(),
  check ((type = 'direct' and direct_key is not null) or (type = 'group' and direct_key is null))
);

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','member')),
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
create index if not exists conv_members_user_idx on public.conversation_members (user_id);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  content text not null check (char_length(content) <= 4000),
  message_type text not null default 'text' check (message_type in ('text')),
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz
);
create index if not exists messages_conv_idx on public.messages (conversation_id, created_at desc);

create table if not exists public.message_reads (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create table if not exists public.stories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  content text check (content is null or char_length(content) <= 500),
  media_path text,
  bg_index smallint not null default 0 check (bg_index between 0 and 5),
  visibility text not null default 'friends' check (visibility in ('friends','public','only_me')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  check (content is not null or media_path is not null),
  check (expires_at <= created_at + interval '24 hours')
);
create index if not exists stories_user_idx on public.stories (user_id, expires_at desc);

create table if not exists public.story_views (
  story_id uuid not null references public.stories(id) on delete cascade,
  viewer_id uuid not null references public.profiles(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (story_id, viewer_id)
);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  reported_user_id uuid not null references public.profiles(id) on delete cascade,
  reason text not null check (reason in ('spam','abuse','impersonation','inappropriate','other')),
  details text check (details is null or char_length(details) <= 1000),
  status text not null default 'open' check (status in ('open','reviewing','resolved','dismissed')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id) on delete set null,
  check (reporter_id <> reported_user_id)
);
create index if not exists reports_status_idx on public.reports (status, created_at desc);

create table if not exists public.admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references public.profiles(id) on delete set null,
  action text not null,
  target_user_id uuid,            -- tanpa FK agar log tetap ada setelah target dihapus
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_created_idx on public.admin_audit_logs (created_at desc);

-- ---------- 3. ID ORVIX & PROFIL OTOMATIS ----------
create or replace function public.gen_orvix_id() returns text
language plpgsql volatile set search_path = public as $$
declare cand text; tries int := 0;
begin
  loop
    cand := (10000000 + floor(random() * 90000000))::bigint::text;   -- 8 digit
    exit when not exists (select 1 from public.profiles where orvix_id = cand);
    tries := tries + 1;
    if tries > 50 then raise exception 'Gagal membuat ID ORVIX'; end if;
  end loop;
  return cand;
end $$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare uname text; dname text; attempt int := 0;
begin
  uname := lower(coalesce(new.raw_user_meta_data->>'username', ''));
  if uname !~ '^[a-z0-9_]{3,20}$' then uname := ''; end if;
  dname := left(btrim(coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), split_part(coalesce(new.email,''), '@', 1))), 40);
  if dname = '' then dname := 'Pengguna'; end if;
  loop
    attempt := attempt + 1;
    begin
      insert into public.profiles (id, orvix_id, username, display_name)
      values (new.id, public.gen_orvix_id(),
              case when uname = '' then 'user' || substr(md5(random()::text), 1, 8) else uname end, dname);
      exit;
    exception when unique_violation then
      if attempt >= 6 then raise; end if;
      uname := '';   -- konflik username/ID: pakai username otomatis
    end;
  end loop;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- 4. FUNGSI PEMBANTU (SECURITY DEFINER, anti-rekursi RLS) ----------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin' and not is_suspended)
$$;

create or replace function public.is_member(conv uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.conversation_members where conversation_id = conv and user_id = auth.uid())
$$;

create or replace function public.is_blocked_between(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.blocked_users
    where (blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a))
$$;

create or replace function public.is_friend(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.friendships f where f.status = 'accepted'
    and ((f.requester_id = a and f.addressee_id = b) or (f.requester_id = b and f.addressee_id = a)))
$$;

create or replace function public.shares_context(uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.friendships f
      where (f.requester_id = auth.uid() and f.addressee_id = uid) or (f.addressee_id = auth.uid() and f.requester_id = uid))
  or exists (select 1 from public.conversation_members a join public.conversation_members b
      on a.conversation_id = b.conversation_id where a.user_id = auth.uid() and b.user_id = uid)
$$;

create or replace function public.can_send(conv uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_member(conv)
    and exists (select 1 from public.profiles where id = auth.uid() and not is_suspended)
    and not exists (
      select 1 from public.conversations c
      join public.conversation_members m on m.conversation_id = c.id and m.user_id <> auth.uid()
      where c.id = conv and c.type = 'direct' and public.is_blocked_between(auth.uid(), m.user_id))
$$;

create or replace function public.can_view_story(owner uuid, vis text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when owner = auth.uid() then true
    when not exists (select 1 from public.profiles where id = owner and not is_suspended) then false
    when public.is_blocked_between(auth.uid(), owner) then false
    when vis = 'public' then true
    when vis = 'friends' then public.is_friend(auth.uid(), owner)
    else false end
$$;

create or replace function public.can_view_story_media(path text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.stories s where s.media_path = path and s.expires_at > now()
                 and public.can_view_story(s.user_id, s.visibility))
$$;

-- Trigger pelindung pesan: hanya isi (maks 15 menit) dan penghapusan lunak yang boleh berubah
create or replace function public.messages_guard() returns trigger
language plpgsql as $$
begin
  if auth.uid() is null then return new; end if;   -- service role / SQL editor
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
drop trigger if exists trg_messages_guard on public.messages;
create trigger trg_messages_guard before update on public.messages
  for each row execute function public.messages_guard();

-- ---------- 5. RPC ----------
create or replace function public.get_my_profile() returns setof public.profiles
language sql stable security definer set search_path = public as $$
  select * from public.profiles where id = auth.uid()
$$;

create or replace function public.username_available(u text) returns boolean
language sql stable security definer set search_path = public as $$
  select u ~ '^[a-z0-9_]{3,20}$' and not exists (select 1 from public.profiles where username = lower(u))
$$;

create or replace function public.touch_presence() returns void
language sql security definer set search_path = public as $$
  update public.profiles set last_seen_at = now() where id = auth.uid()
$$;

create or replace function public.get_last_seen(target uuid) returns timestamptz
language sql stable security definer set search_path = public as $$
  select case when p.show_last_seen and public.shares_context(p.id)
              and not public.is_blocked_between(auth.uid(), p.id) then p.last_seen_at end
  from public.profiles p where p.id = target
$$;

create or replace function public.find_user_by_orvix_id(q text)
returns table (id uuid, orvix_id text, username text, display_name text, avatar_url text, is_verified boolean, relation text)
language sql stable security definer set search_path = public as $$
  select p.id, p.orvix_id, p.username, p.display_name,
    case when p.profile_public or public.shares_context(p.id) then p.avatar_url end,
    p.is_verified,
    case when p.id = auth.uid() then 'self'
         when public.is_friend(auth.uid(), p.id) then 'friend'
         when exists (select 1 from public.friendships f where f.status = 'pending' and f.requester_id = auth.uid() and f.addressee_id = p.id) then 'pending_out'
         when exists (select 1 from public.friendships f where f.status = 'pending' and f.addressee_id = auth.uid() and f.requester_id = p.id) then 'pending_in'
         else 'none' end
  from public.profiles p
  where p.orvix_id = btrim(q) and not p.is_suspended and not public.is_blocked_between(auth.uid(), p.id)
$$;

create or replace function public.send_friend_request(target uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); ex public.friendships; fid uuid;
begin
  if me is null then raise exception 'Belum login'; end if;
  if not exists (select 1 from public.profiles where id = me and not is_suspended) then raise exception 'Akun dinonaktifkan'; end if;
  if target = me then raise exception 'Tidak bisa menambahkan diri sendiri'; end if;
  if not exists (select 1 from public.profiles where id = target and not is_suspended) then raise exception 'Pengguna tidak ditemukan'; end if;
  if public.is_blocked_between(me, target) then raise exception 'Tidak dapat mengirim permintaan ke pengguna ini'; end if;
  select * into ex from public.friendships f
    where least(f.requester_id, f.addressee_id) = least(me, target) and greatest(f.requester_id, f.addressee_id) = greatest(me, target);
  if found then
    if ex.status = 'accepted' then raise exception 'Kalian sudah berteman'; end if;
    if ex.requester_id = me then raise exception 'Permintaan sudah dikirim'; end if;
    update public.friendships set status = 'accepted' where id = ex.id;   -- saling meminta
    return ex.id;
  end if;
  insert into public.friendships (requester_id, addressee_id) values (me, target) returning id into fid;
  return fid;
end $$;

create or replace function public.respond_friend_request(fid uuid, accept boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.friendships where id = fid and addressee_id = auth.uid() and status = 'pending') then
    raise exception 'Permintaan tidak ditemukan';
  end if;
  if accept then update public.friendships set status = 'accepted' where id = fid;
  else delete from public.friendships where id = fid; end if;
end $$;

create or replace function public.remove_friendship(fid uuid) returns void
language sql security definer set search_path = public as $$
  delete from public.friendships where id = fid and (requester_id = auth.uid() or addressee_id = auth.uid())
$$;

create or replace function public.block_user(target uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if target = auth.uid() then raise exception 'Tidak bisa memblokir diri sendiri'; end if;
  if not exists (select 1 from public.profiles where id = target) then raise exception 'Pengguna tidak ditemukan'; end if;
  insert into public.blocked_users (blocker_id, blocked_id) values (auth.uid(), target) on conflict do nothing;
  delete from public.friendships f
    where (f.requester_id = auth.uid() and f.addressee_id = target) or (f.requester_id = target and f.addressee_id = auth.uid());
end $$;

create or replace function public.unblock_user(target uuid) returns void
language sql security definer set search_path = public as $$
  delete from public.blocked_users where blocker_id = auth.uid() and blocked_id = target
$$;

create or replace function public.start_direct_chat(target uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); k text; cid uuid;
begin
  if me is null or target = me then raise exception 'Permintaan tidak valid'; end if;
  if not public.is_friend(me, target) then raise exception 'Chat hanya bisa dengan teman'; end if;
  if public.is_blocked_between(me, target) then raise exception 'Tidak dapat memulai chat'; end if;
  k := least(me, target)::text || '_' || greatest(me, target)::text;
  insert into public.conversations (type, created_by, direct_key) values ('direct', me, k)
    on conflict (direct_key) do nothing returning id into cid;
  if cid is null then
    select id into cid from public.conversations where direct_key = k;
  else
    insert into public.conversation_members (conversation_id, user_id, role) values (cid, me, 'member'), (cid, target, 'member');
  end if;
  return cid;
end $$;

create or replace function public.create_group(title text, member_ids uuid[]) returns uuid
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); cid uuid; m uuid; ids uuid[];
begin
  if me is null then raise exception 'Belum login'; end if;
  if title is null or char_length(btrim(title)) not between 1 and 60 then raise exception 'Nama grup 1-60 karakter'; end if;
  select coalesce(array_agg(distinct x), '{}') into ids from unnest(member_ids) x where x <> me;
  if coalesce(array_length(ids, 1), 0) < 1 or array_length(ids, 1) > 49 then raise exception 'Pilih 1-49 teman'; end if;
  foreach m in array ids loop
    if not public.is_friend(me, m) or public.is_blocked_between(me, m) then raise exception 'Semua anggota harus teman yang tidak diblokir'; end if;
  end loop;
  insert into public.conversations (type, title, created_by) values ('group', btrim(title), me) returning id into cid;
  insert into public.conversation_members (conversation_id, user_id, role) values (cid, me, 'owner');
  insert into public.conversation_members (conversation_id, user_id) select cid, unnest(ids);
  return cid;
end $$;

create or replace function public.leave_group(conv uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.conversations where id = conv and type = 'group') then raise exception 'Bukan grup'; end if;
  delete from public.conversation_members where conversation_id = conv and user_id = auth.uid();
  if not exists (select 1 from public.conversation_members where conversation_id = conv) then
    delete from public.conversations where id = conv;
  end if;
end $$;

create or replace function public.mark_read(conv uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member(conv) then raise exception 'Bukan anggota'; end if;
  insert into public.message_reads (conversation_id, user_id, last_read_at) values (conv, auth.uid(), now())
    on conflict (conversation_id, user_id) do update set last_read_at = now();
end $$;

create or replace function public.list_my_conversations()
returns table (conv_id uuid, conv_type text, title text, other_id uuid, other_username text, other_name text,
               other_avatar text, other_verified boolean, last_content text, last_at timestamptz,
               last_sender uuid, last_deleted boolean, unread bigint, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select c.id, c.type, c.title, o.id, o.username, o.display_name, o.avatar_url, o.is_verified,
         lm.content, lm.created_at, lm.sender_id, (lm.deleted_at is not null),
         (select count(*) from public.messages m where m.conversation_id = c.id and m.sender_id <> auth.uid()
            and m.deleted_at is null and m.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)),
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
    where m.conversation_id = c.id order by m.created_at desc limit 1) lm on true
  order by coalesce(lm.created_at, c.created_at) desc
$$;

-- Pembersihan baris story kedaluwarsa (berkas media di Storage perlu dibersihkan terpisah)
create or replace function public.purge_expired_stories() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from public.stories where expires_at < now() - interval '2 days';
  get diagnostics n = row_count; return n;
end $$;

-- ---------- 6. ROW LEVEL SECURITY ----------
alter table public.profiles enable row level security;
alter table public.friendships enable row level security;
alter table public.blocked_users enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
alter table public.message_reads enable row level security;
alter table public.stories enable row level security;
alter table public.story_views enable row level security;
alter table public.reports enable row level security;
alter table public.admin_audit_logs enable row level security;   -- tanpa policy: hanya service role

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or profile_public or public.shares_context(id));
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists friendships_select on public.friendships;
create policy friendships_select on public.friendships for select to authenticated
  using (requester_id = auth.uid() or addressee_id = auth.uid());

drop policy if exists blocked_select on public.blocked_users;
create policy blocked_select on public.blocked_users for select to authenticated using (blocker_id = auth.uid());

drop policy if exists conv_select on public.conversations;
create policy conv_select on public.conversations for select to authenticated using (public.is_member(id));

drop policy if exists members_select on public.conversation_members;
create policy members_select on public.conversation_members for select to authenticated using (public.is_member(conversation_id));

drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages for select to authenticated using (public.is_member(conversation_id));
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated
  with check (sender_id = auth.uid() and message_type = 'text' and public.can_send(conversation_id)
              and char_length(btrim(content)) between 1 and 4000);
drop policy if exists messages_update on public.messages;
create policy messages_update on public.messages for update to authenticated
  using (sender_id = auth.uid() and deleted_at is null and public.is_member(conversation_id))
  with check (sender_id = auth.uid());

drop policy if exists stories_select on public.stories;
create policy stories_select on public.stories for select to authenticated
  using (user_id = auth.uid() or (expires_at > now() and public.can_view_story(user_id, visibility)));
drop policy if exists stories_insert on public.stories;
create policy stories_insert on public.stories for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.profiles where id = auth.uid() and not is_suspended)
              and (media_path is null or media_path like auth.uid()::text || '/%'));
drop policy if exists stories_delete on public.stories;
create policy stories_delete on public.stories for delete to authenticated using (user_id = auth.uid());

drop policy if exists story_views_select on public.story_views;
create policy story_views_select on public.story_views for select to authenticated
  using (viewer_id = auth.uid() or exists (select 1 from public.stories s where s.id = story_id and s.user_id = auth.uid()));
drop policy if exists story_views_insert on public.story_views;
create policy story_views_insert on public.story_views for insert to authenticated
  with check (viewer_id = auth.uid() and exists (select 1 from public.stories s where s.id = story_id));

drop policy if exists reports_select on public.reports;
create policy reports_select on public.reports for select to authenticated using (reporter_id = auth.uid());
drop policy if exists reports_insert on public.reports;
create policy reports_insert on public.reports for insert to authenticated
  with check (reporter_id = auth.uid() and reported_user_id <> auth.uid());

-- ---------- 7. GRANTS (least privilege; kolom sensitif tidak bisa diubah klien) ----------
revoke all on public.profiles, public.friendships, public.blocked_users, public.conversations,
  public.conversation_members, public.messages, public.message_reads, public.stories,
  public.story_views, public.reports, public.admin_audit_logs from anon, authenticated;

grant select (id, orvix_id, username, display_name, avatar_url, status_text, is_verified, verified_at,
              profile_public, show_last_seen, story_visibility, created_at) on public.profiles to authenticated;
grant update (display_name, username, avatar_url, status_text, profile_public, show_last_seen, story_visibility)
  on public.profiles to authenticated;
grant select on public.friendships, public.blocked_users, public.conversations, public.conversation_members to authenticated;
grant select on public.messages to authenticated;
grant insert (conversation_id, sender_id, content) on public.messages to authenticated;
grant update (content, deleted_at) on public.messages to authenticated;
grant select on public.stories to authenticated;
grant insert (user_id, content, media_path, bg_index, visibility) on public.stories to authenticated;
grant delete on public.stories to authenticated;
grant select, insert on public.story_views to authenticated;
grant select on public.reports to authenticated;
grant insert (reporter_id, reported_user_id, reason, details) on public.reports to authenticated;

-- ---------- 8. STORAGE ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('avatars', 'avatars', true, 2097152, array['image/jpeg','image/png','image/webp']),
  ('stories', 'stories', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists avatars_select on storage.objects;
create policy avatars_select on storage.objects for select to authenticated using (bucket_id = 'avatars');
drop policy if exists avatars_insert on storage.objects;
create policy avatars_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists avatars_update on storage.objects;
create policy avatars_update on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists avatars_delete on storage.objects;
create policy avatars_delete on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists stories_obj_select on storage.objects;
create policy stories_obj_select on storage.objects for select to authenticated
  using (bucket_id = 'stories' and ((storage.foldername(name))[1] = auth.uid()::text or public.can_view_story_media(name)));
drop policy if exists stories_obj_insert on storage.objects;
create policy stories_obj_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'stories' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists stories_obj_delete on storage.objects;
create policy stories_obj_delete on storage.objects for delete to authenticated
  using (bucket_id = 'stories' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- 9. REALTIME ----------
do $$ begin
  begin alter publication supabase_realtime add table public.messages; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.friendships; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.conversation_members; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.stories; exception when duplicate_object then null; end;
end $$;

-- ---------- 10. IZIN EKSEKUSI FUNGSI ----------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.username_available(text) to anon, authenticated;
grant execute on function
  public.is_admin(), public.is_member(uuid), public.is_blocked_between(uuid, uuid), public.is_friend(uuid, uuid),
  public.shares_context(uuid), public.can_send(uuid), public.can_view_story(uuid, text), public.can_view_story_media(text),
  public.get_my_profile(), public.touch_presence(), public.get_last_seen(uuid), public.find_user_by_orvix_id(text),
  public.send_friend_request(uuid), public.respond_friend_request(uuid, boolean), public.remove_friendship(uuid),
  public.block_user(uuid), public.unblock_user(uuid), public.start_direct_chat(uuid), public.create_group(text, uuid[]),
  public.leave_group(uuid), public.mark_read(uuid), public.list_my_conversations()
  to authenticated;
-- gen_orvix_id, handle_new_user, messages_guard, purge_expired_stories: hanya trigger/service role.
-- Catatan: policy RLS memanggil fungsi sebagai role authenticated, jadi helper di atas harus tetap executable.
