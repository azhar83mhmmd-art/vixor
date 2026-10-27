-- ORVIX BAGIAN 13a: perbaikan fitur Blokir / Buka blokir.
-- Aman dijalankan ulang. Tidak membuat tabel baru, tidak mematikan RLS, tidak menghapus data.
-- Akar masalah yang diperbaiki:
--  1) Izin EXECUTE fungsi bisa hilang (mis. setelah supabase.sql dijalankan ulang) -> klien menerima "permission denied / function not found".
--  2) Daftar "Pengguna diblokir" bergantung pada RLS profiles; profil yang tidak lagi berbagi konteks (pertemanan dihapus saat blokir) tersembunyi.
--  3) Fungsi lama tidak memvalidasi login dan pesan galatnya tidak jelas.

grant select on public.blocked_users to authenticated;
drop policy if exists blocked_select on public.blocked_users;
create policy blocked_select on public.blocked_users for select to authenticated using (blocker_id = auth.uid());

create or replace function public.is_blocked_between(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.blocked_users
    where (blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a))
$$;

create or replace function public.block_user(target uuid) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'Sesi berakhir. Silakan masuk lagi.'; end if;
  if target is null or target = me then raise exception 'Tidak bisa memblokir diri sendiri'; end if;
  if not exists (select 1 from public.profiles where id = target) then raise exception 'Pengguna tidak ditemukan'; end if;
  insert into public.blocked_users (blocker_id, blocked_id) values (me, target)
    on conflict (blocker_id, blocked_id) do nothing;
  delete from public.friendships f
    where (f.requester_id = me and f.addressee_id = target) or (f.requester_id = target and f.addressee_id = me);
end $$;

create or replace function public.unblock_user(target uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sesi berakhir. Silakan masuk lagi.'; end if;
  delete from public.blocked_users where blocker_id = auth.uid() and blocked_id = target;
end $$;

-- Daftar yang SAYA blokir lengkap dengan profil (tidak terhalang RLS profiles)
create or replace function public.orvix_list_blocked()
returns table (user_id uuid, display_name text, username text, avatar_url text, is_verified boolean, blocked_at timestamptz)
language sql stable security definer set search_path = public as $$
  select b.blocked_id, p.display_name, p.username, p.avatar_url, p.is_verified, b.created_at
  from public.blocked_users b join public.profiles p on p.id = b.blocked_id
  where b.blocker_id = auth.uid() order by b.created_at desc
$$;

-- Pasang ulang izin eksekusi yang dipakai aplikasi (hanya fungsi yang memang ada)
do $$
declare s text;
begin
  foreach s in array array[
    'public.is_blocked_between(uuid, uuid)', 'public.block_user(uuid)', 'public.unblock_user(uuid)', 'public.orvix_list_blocked()',
    'public.is_member(uuid)', 'public.is_friend(uuid, uuid)', 'public.can_send(uuid)', 'public.shares_context(uuid)',
    'public.start_direct_chat(uuid)', 'public.list_my_conversations()', 'public.mark_read(uuid)'
  ] loop
    if to_regprocedure(s) is not null then
      execute format('revoke all on function %s from public, anon', s);
      execute format('grant execute on function %s to authenticated', s);
    end if;
  end loop;
end $$;
-- ORVIX BAGIAN 13b: hapus pesan hanya 1 jam, hapus/sematkan chat dari daftar. Aman dijalankan ulang.

-- Pelindung pesan: hapus-untuk-semua hanya dalam 1 jam. Edit: 15 menit (Premium: 1 jam). Pesan sistem tidak bisa diubah.
create or replace function public.messages_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare prem boolean;
begin
  if auth.uid() is null then return new; end if;   -- service role / SQL editor
  if old.message_type = 'system' then raise exception 'Pesan sistem tidak dapat diubah'; end if;
  if new.conversation_id <> old.conversation_id or new.sender_id <> old.sender_id
     or new.created_at <> old.created_at or new.message_type <> old.message_type then
    raise exception 'Kolom pesan ini tidak dapat diubah';
  end if;
  if old.deleted_at is not null then raise exception 'Pesan sudah dihapus'; end if;
  if new.deleted_at is not null then
    if now() - old.created_at > interval '1 hour' then raise exception 'Pesan hanya bisa dihapus dalam 1 jam setelah dikirim'; end if;
    new.deleted_at := now(); new.content := '';
  elsif new.content is distinct from old.content then
    select coalesce(premium_until > now(), false) into prem from public.profiles where id = old.sender_id;
    if now() - old.created_at > (case when prem then interval '1 hour' else interval '15 minutes' end) then
      raise exception 'Batas waktu edit pesan sudah lewat'; end if;
    if char_length(btrim(new.content)) < 1 then raise exception 'Pesan tidak boleh kosong'; end if;
    new.edited_at := now();
  end if;
  return new;
end $$;

-- Preferensi chat per pengguna: sematan (pin) dan "hapus chat" (kosongkan riwayat hanya untuk saya)
create table if not exists public.orvix_conv_prefs (
  user_id uuid not null references public.profiles(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  pinned_at timestamptz,
  cleared_at timestamptz,
  primary key (user_id, conversation_id)
);
alter table public.orvix_conv_prefs enable row level security;
drop policy if exists conv_prefs_select on public.orvix_conv_prefs;
create policy conv_prefs_select on public.orvix_conv_prefs for select to authenticated using (user_id = auth.uid());
revoke all on public.orvix_conv_prefs from anon, authenticated;
grant select on public.orvix_conv_prefs to authenticated;

create or replace function public.orvix_pin_conversations(convs uuid[], pin boolean) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); c uuid; lim int; cur int; prem boolean;
begin
  if me is null then raise exception 'Sesi berakhir. Silakan masuk lagi.'; end if;
  select coalesce(premium_until > now(), false) into prem from public.profiles where id = me;
  lim := case when prem then 10 else 3 end;
  foreach c in array coalesce(convs, '{}') loop
    if not exists (select 1 from public.conversation_members where conversation_id = c and user_id = me) then continue; end if;
    if pin then
      select count(*) into cur from public.orvix_conv_prefs where user_id = me and pinned_at is not null and conversation_id <> c;
      if cur >= lim then raise exception 'Maksimal % chat disematkan%', lim, case when prem then '.' else '. Premium bisa menyematkan hingga 10 chat.' end; end if;
      insert into public.orvix_conv_prefs (user_id, conversation_id, pinned_at) values (me, c, now())
        on conflict (user_id, conversation_id) do update set pinned_at = now();
    else
      update public.orvix_conv_prefs set pinned_at = null where user_id = me and conversation_id = c;
    end if;
  end loop;
end $$;

create or replace function public.orvix_clear_conversations(convs uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); c uuid;
begin
  if me is null then raise exception 'Sesi berakhir. Silakan masuk lagi.'; end if;
  foreach c in array coalesce(convs, '{}') loop
    if not exists (select 1 from public.conversation_members where conversation_id = c and user_id = me) then continue; end if;
    insert into public.orvix_conv_prefs (user_id, conversation_id, cleared_at, pinned_at) values (me, c, now(), null)
      on conflict (user_id, conversation_id) do update set cleared_at = now(), pinned_at = null;
  end loop;
end $$;

-- Daftar chat: sematan di atas, chat yang dihapus disembunyikan sampai ada pesan baru
drop function if exists public.list_my_conversations();
create function public.list_my_conversations()
returns table (conv_id uuid, conv_type text, title text, other_id uuid, other_username text, other_name text,
               other_avatar text, other_verified boolean, last_content text, last_at timestamptz,
               last_sender uuid, last_deleted boolean, unread bigint, created_at timestamptz,
               pinned boolean, cleared_at timestamptz)
language sql stable security definer set search_path = public as $$
  select conv_id, conv_type, title, other_id, other_username, other_name, other_avatar, other_verified, last_content, last_at,
         last_sender, last_deleted, unread, created_at, pinned, cleared_at
  from (
    select c.id, c.type, c.title, o.id, o.username, o.display_name, o.avatar_url, o.is_verified,
           lm.content, lm.created_at, lm.sender_id, (lm.deleted_at is not null),
           (select count(*) from public.messages m where m.conversation_id = c.id and m.sender_id <> auth.uid()
              and m.deleted_at is null and m.message_type <> 'system' and (m.expires_at is null or m.expires_at > now())
              and m.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)
              and m.created_at > coalesce(pf.cleared_at, '-infinity'::timestamptz)),
           c.created_at, (pf.pinned_at is not null), pf.cleared_at, pf.pinned_at as pin_at
    from public.conversations c
    join public.conversation_members me on me.conversation_id = c.id and me.user_id = auth.uid()
    left join public.message_reads r on r.conversation_id = c.id and r.user_id = auth.uid()
    left join public.orvix_conv_prefs pf on pf.conversation_id = c.id and pf.user_id = auth.uid()
    left join lateral (
      select p.id, p.username, p.display_name, p.avatar_url, p.is_verified
      from public.conversation_members cm join public.profiles p on p.id = cm.user_id
      where cm.conversation_id = c.id and cm.user_id <> auth.uid() and c.type = 'direct' limit 1) o on true
    left join lateral (
      select m.content, m.created_at, m.sender_id, m.deleted_at from public.messages m
      where m.conversation_id = c.id and m.message_type <> 'system' and (m.expires_at is null or m.expires_at > now())
        and m.created_at > coalesce(pf.cleared_at, '-infinity'::timestamptz)
      order by m.created_at desc limit 1) lm on true
    where pf.cleared_at is null or lm.created_at is not null
  ) x(conv_id, conv_type, title, other_id, other_username, other_name, other_avatar, other_verified, last_content, last_at,
      last_sender, last_deleted, unread, created_at, pinned, cleared_at, pin_at)
  order by (pin_at is not null) desc, pin_at desc nulls last, coalesce(last_at, created_at) desc
$$;

revoke all on function public.orvix_pin_conversations(uuid[], boolean), public.orvix_clear_conversations(uuid[]), public.list_my_conversations() from public, anon;
grant execute on function public.orvix_pin_conversations(uuid[], boolean), public.orvix_clear_conversations(uuid[]), public.list_my_conversations() to authenticated;
-- ORVIX BAGIAN 13c: menu Kontak (orang yang pernah dihubungi atau dicari). Aman dijalankan ulang.
create table if not exists public.orvix_saved_contacts (
  owner_id uuid not null references public.profiles(id) on delete cascade,
  contact_id uuid not null references public.profiles(id) on delete cascade,
  source text not null default 'search' check (source in ('chat','search')),
  last_at timestamptz not null default now(),
  removed boolean not null default false,
  primary key (owner_id, contact_id),
  check (owner_id <> contact_id)
);
alter table public.orvix_saved_contacts enable row level security;
revoke all on public.orvix_saved_contacts from anon, authenticated;   -- akses hanya lewat fungsi di bawah

create or replace function public.orvix_save_contact(target uuid, src text default 'search') returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); s text := case when src = 'chat' then 'chat' else 'search' end;
begin
  if me is null or target is null or target = me then return; end if;
  if not exists (select 1 from public.profiles where id = target and not is_suspended) then return; end if;
  if public.is_blocked_between(me, target) then return; end if;
  insert into public.orvix_saved_contacts (owner_id, contact_id, source, last_at, removed)
    values (me, target, s, now(), false)
    on conflict (owner_id, contact_id) do update
      set last_at = now(), removed = false,
          source = case when public.orvix_saved_contacts.source = 'chat' or excluded.source = 'chat' then 'chat' else 'search' end;
end $$;

create or replace function public.orvix_remove_saved_contact(target uuid) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'Sesi berakhir. Silakan masuk lagi.'; end if;
  insert into public.orvix_saved_contacts (owner_id, contact_id, source, removed) values (me, target, 'search', true)
    on conflict (owner_id, contact_id) do update set removed = true;
end $$;

-- Gabungan: lawan chat pribadi (otomatis, kecuali dihapus dari kontak) + orang yang pernah dicari lewat ID ORVIX
create or replace function public.orvix_saved_contacts_list(p_q text default '')
returns table (user_id uuid, orvix_id text, username text, display_name text, avatar_url text, is_verified boolean,
               status_text text, source text, last_at timestamptz)
language sql stable security definer set search_path = public as $$
  with me as (select auth.uid() as id),
  chats as (
    select x.uid, max(x.at) as at from (
      select cm2.user_id as uid,
             coalesce((select max(m.created_at) from public.messages m where m.conversation_id = c.id), c.created_at) as at
      from public.conversations c
      join public.conversation_members cm1 on cm1.conversation_id = c.id and cm1.user_id = (select id from me)
      join public.conversation_members cm2 on cm2.conversation_id = c.id and cm2.user_id <> (select id from me)
      where c.type = 'direct') x group by x.uid
  ),
  allc as (
    select uid, at, 'chat'::text as src from chats
    union all
    select s.contact_id, s.last_at, s.source from public.orvix_saved_contacts s
    where s.owner_id = (select id from me) and not s.removed
  ),
  pick as (
    select uid, max(at) as at, case when bool_or(src = 'chat') then 'chat' else 'search' end as src
    from allc a
    where not exists (select 1 from public.orvix_saved_contacts r where r.owner_id = (select id from me) and r.contact_id = a.uid and r.removed)
    group by uid
  )
  select p.id, p.orvix_id::text, p.username, p.display_name, p.avatar_url, p.is_verified, p.status_text, k.src, k.at
  from pick k join public.profiles p on p.id = k.uid
  where not p.is_suspended and not public.is_blocked_between((select id from me), p.id)
    and (coalesce(btrim(p_q), '') = '' or p.display_name ilike '%' || btrim(p_q) || '%' or p.username ilike '%' || btrim(p_q) || '%' or p.orvix_id::text = btrim(p_q))
  order by k.at desc limit 200
$$;

revoke all on function public.orvix_save_contact(uuid, text), public.orvix_remove_saved_contact(uuid), public.orvix_saved_contacts_list(text) from public, anon;
grant execute on function public.orvix_save_contact(uuid, text), public.orvix_remove_saved_contact(uuid), public.orvix_saved_contacts_list(text) to authenticated;
-- ORVIX BAGIAN 13d: fitur khusus Premium (gaya bubble/aksen, bingkai profil, insight chat). Aman dijalankan ulang.
-- Premium tetap diaktifkan admin (12k). Klien tidak bisa mengubah premium_until.
alter table public.profiles add column if not exists premium_prefs jsonb not null default '{}'::jsonb;

create or replace function public.orvix_is_premium(uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select premium_until > now() from public.profiles where id = uid), false)
$$;

-- Simpan gaya Premium: bubble, aksen, aura profil. Hanya pengguna Premium aktif.
create or replace function public.orvix_set_premium_prefs(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); b text := p->>'bubble'; a text := p->>'accent'; r boolean := coalesce((p->>'ring')::boolean, false); res jsonb;
begin
  if me is null then raise exception 'Sesi berakhir. Silakan masuk lagi.'; end if;
  if not public.orvix_is_premium(me) then raise exception 'Fitur ini khusus ORVIX Premium'; end if;
  if b is not null and b not in ('default','aurora','sunset','mint','rose','mono','gold') then raise exception 'Gaya bubble tidak valid'; end if;
  if a is not null and a not in ('default','aurora','sunset','mint','rose','gold') then raise exception 'Aksen tidak valid'; end if;
  res := jsonb_build_object('bubble', coalesce(b, 'default'), 'accent', coalesce(a, 'default'), 'ring', r);
  update public.profiles set premium_prefs = res where id = me;
  return res;
end $$;

-- Insight aktivitas chat 30 hari terakhir (hanya milikmu sendiri)
create or replace function public.orvix_premium_insights() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me uuid := auth.uid(); res jsonb;
begin
  if me is null or not public.orvix_is_premium(me) then raise exception 'Fitur ini khusus ORVIX Premium'; end if;
  select jsonb_build_object(
    'sent_30d', (select count(*) from public.messages where sender_id = me and message_type <> 'system' and created_at > now() - interval '30 days'),
    'media_30d', (select count(*) from public.messages where sender_id = me and message_type in ('image','video') and created_at > now() - interval '30 days'),
    'active_chats', (select count(distinct conversation_id) from public.messages where sender_id = me and created_at > now() - interval '30 days'),
    'busiest_hour', (select extract(hour from created_at at time zone 'Asia/Jakarta')::int from public.messages
                     where sender_id = me and created_at > now() - interval '30 days'
                     group by 1 order by count(*) desc limit 1),
    'top', coalesce((select jsonb_agg(t) from (
        select p.display_name as name, count(*) as n
        from public.messages m
        join public.conversations c on c.id = m.conversation_id and c.type = 'direct'
        join public.conversation_members cm on cm.conversation_id = m.conversation_id and cm.user_id <> me
        join public.profiles p on p.id = cm.user_id
        where m.created_at > now() - interval '30 days' and m.message_type <> 'system'
          and exists (select 1 from public.conversation_members x where x.conversation_id = m.conversation_id and x.user_id = me)
        group by p.id, p.display_name order by count(*) desc limit 3) t), '[]'::jsonb)
  ) into res;
  return res;
end $$;

revoke all on function public.orvix_is_premium(uuid), public.orvix_set_premium_prefs(jsonb), public.orvix_premium_insights() from public, anon;
grant execute on function public.orvix_is_premium(uuid), public.orvix_set_premium_prefs(jsonb), public.orvix_premium_insights() to authenticated;
