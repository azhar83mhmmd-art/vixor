-- ORVIX BAGIAN 19b: admin grup, izin grup, riwayat anggota. Idempotent, tidak menghapus data/grup lama.
-- Jalankan SETELAH 19a, 12c, 17a. Satu file per Run. Pemilik grup lama otomatis tetap 'owner'.

-- 1) Peran 'admin' pada anggota ---------------------------------------------------------------------
do $$ declare r record; begin
  for r in select conname from pg_constraint where conrelid = 'public.conversation_members'::regclass and contype = 'c'
           and pg_get_constraintdef(oid) ilike '%role%'
  loop execute format('alter table public.conversation_members drop constraint %I', r.conname); end loop;
end $$;
alter table public.conversation_members add constraint conversation_members_role_check check (role in ('owner','admin','member'));

-- 2) Izin grup -------------------------------------------------------------------------------------
alter table public.conversations add column if not exists send_policy text not null default 'all';
alter table public.conversations add column if not exists info_policy text not null default 'admins';
alter table public.conversations drop constraint if exists conversations_send_policy_check;
alter table public.conversations add constraint conversations_send_policy_check check (send_policy in ('all','admins'));
alter table public.conversations drop constraint if exists conversations_info_policy_check;
alter table public.conversations add constraint conversations_info_policy_check check (info_policy in ('all','admins'));

-- 3) Riwayat tindakan admin (hanya ditulis lewat RPC) ----------------------------------------------
create table if not exists public.orvix_group_log (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  target_id uuid references public.profiles(id) on delete set null,
  action text not null check (action in ('add','remove','leave','promote','demote','info','policy','owner')),
  created_at timestamptz not null default now()
);
create index if not exists orvix_group_log_idx on public.orvix_group_log (conversation_id, created_at desc);
alter table public.orvix_group_log enable row level security;
drop policy if exists group_log_select on public.orvix_group_log;
create policy group_log_select on public.orvix_group_log for select to authenticated using (public.is_member(conversation_id));
revoke all on public.orvix_group_log from anon, authenticated;
grant select on public.orvix_group_log to authenticated;

-- 4) Helper peran -----------------------------------------------------------------------------------
create or replace function public.orvix_group_role(conv uuid, uid uuid) returns text
language sql stable security definer set search_path = public as $$
  select m.role from public.conversation_members m join public.conversations c on c.id = m.conversation_id
  where m.conversation_id = conv and m.user_id = uid and c.type = 'group'
$$;
revoke execute on function public.orvix_group_role(uuid, uuid) from public, anon, authenticated;

create or replace function public.orvix_group_log_add(conv uuid, act text, tgt uuid, sys text) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.orvix_group_log (conversation_id, actor_id, target_id, action) values (conv, auth.uid(), tgt, act);
  if sys is not null then
    insert into public.messages (conversation_id, sender_id, message_type, content) values (conv, auth.uid(), 'system', sys);
  end if;
end $$;
revoke execute on function public.orvix_group_log_add(uuid, text, uuid, text) from public, anon, authenticated;

-- 5) Pengiriman pesan: grup 'hanya admin' (saluran dan chat pribadi tetap seperti sebelumnya) -------
create or replace function public.can_send(conv uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_member(conv)
    and exists (select 1 from public.profiles where id = auth.uid() and not is_suspended)
    and (not exists (select 1 from public.conversations c where c.id = conv and c.type = 'channel')
         or exists (select 1 from public.conversation_members m where m.conversation_id = conv and m.user_id = auth.uid() and m.role = 'owner'))
    and (not exists (select 1 from public.conversations c where c.id = conv and c.type = 'group' and c.send_policy = 'admins')
         or exists (select 1 from public.conversation_members m where m.conversation_id = conv and m.user_id = auth.uid() and m.role in ('owner','admin')))
    and not exists (
      select 1 from public.conversations c
      join public.conversation_members m on m.conversation_id = c.id and m.user_id <> auth.uid()
      where c.id = conv and c.type = 'direct' and public.is_blocked_between(auth.uid(), m.user_id))
$$;

-- 6) Ringkasan grup (satu panggilan): info + anggota + peran saya -----------------------------------
create or replace function public.orvix_group_overview(conv uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c record; res jsonb;
begin
  if not public.is_member(conv) then raise exception 'Bukan anggota'; end if;
  select id, title, description, avatar_url, created_at, send_policy, info_policy, disappear_secs, type into c from public.conversations where id = conv;
  if c.type <> 'group' then raise exception 'Bukan grup'; end if;
  select jsonb_build_object(
    'id', c.id, 'title', c.title, 'description', c.description, 'avatar_url', c.avatar_url, 'created_at', c.created_at,
    'send_policy', c.send_policy, 'info_policy', c.info_policy, 'disappear_secs', c.disappear_secs,
    'my_role', public.orvix_group_role(conv, auth.uid()),
    'members', coalesce((select jsonb_agg(jsonb_build_object(
        'user_id', p.id, 'role', m.role, 'joined_at', m.joined_at, 'display_name', p.display_name, 'username', p.username,
        'orvix_id', p.orvix_id, 'avatar_url', p.avatar_url, 'is_verified', p.is_verified, 'is_creator', p.is_creator,
        'is_business', p.is_business, 'is_official', p.is_official,
        'premium_until', case when p.premium_until > now() then p.premium_until end)
      order by (m.role = 'owner') desc, (m.role = 'admin') desc, lower(p.display_name))
      from public.conversation_members m join public.profiles p on p.id = m.user_id
      where m.conversation_id = conv and not p.is_suspended), '[]'::jsonb)
  ) into res;
  return res;
end $$;

-- 7) Ubah info grup (nama, deskripsi, foto) -----------------------------------------------------------
create or replace function public.orvix_group_update_info(conv uuid, p_title text default null, p_description text default null, p_avatar_url text default null, p_set_avatar boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare r text := public.orvix_group_role(conv, auth.uid()); pol text;
begin
  if r is null then raise exception 'Bukan anggota grup'; end if;
  select info_policy into pol from public.conversations where id = conv;
  if r = 'member' and pol <> 'all' then raise exception 'Hanya admin yang bisa mengubah info grup'; end if;
  if p_title is not null and char_length(btrim(p_title)) not between 1 and 60 then raise exception 'Nama grup 1 sampai 60 karakter'; end if;
  if p_description is not null and char_length(p_description) > 300 then raise exception 'Deskripsi maksimal 300 karakter'; end if;
  if p_set_avatar and p_avatar_url is not null and (char_length(p_avatar_url) > 500
      or p_avatar_url not like ('%/storage/v1/object/public/avatars/' || auth.uid()::text || '/%')) then
    raise exception 'Alamat foto tidak valid'; end if;
  update public.conversations set
    title = coalesce(nullif(btrim(p_title), ''), title),
    description = case when p_description is null then description else nullif(btrim(p_description), '') end,
    avatar_url = case when p_set_avatar then p_avatar_url else avatar_url end
  where id = conv;
  perform public.orvix_group_log_add(conv, 'info', null, case when p_title is not null then 'mengubah nama grup' when p_set_avatar then 'mengubah ikon grup' else 'mengubah deskripsi grup' end);
end $$;

-- 8) Kebijakan grup (siapa boleh kirim / ubah info) -----------------------------------------------------
create or replace function public.orvix_group_set_policy(conv uuid, p_send text, p_info text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.orvix_group_role(conv, auth.uid()) not in ('owner','admin') then raise exception 'Hanya admin grup'; end if;
  if p_send not in ('all','admins') or p_info not in ('all','admins') then raise exception 'Nilai tidak valid'; end if;
  update public.conversations set send_policy = p_send, info_policy = p_info where id = conv;
  perform public.orvix_group_log_add(conv, 'policy', null, null);
end $$;

-- 9) Anggota: tambah, keluarkan, jadikan/cabut admin ---------------------------------------------------
create or replace function public.orvix_group_add_members(conv uuid, uids uuid[]) returns integer
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); u uuid; added int := 0; cnt int; nm text;
begin
  if public.orvix_group_role(conv, me) not in ('owner','admin') then raise exception 'Hanya admin grup yang bisa menambah anggota'; end if;
  if uids is null or array_length(uids, 1) is null or array_length(uids, 1) > 50 then raise exception 'Pilih 1 sampai 50 pengguna'; end if;
  select count(*) into cnt from public.conversation_members where conversation_id = conv;
  foreach u in array (select array(select distinct x from unnest(uids) x)) loop
    continue when u = me;
    continue when cnt + added >= 256;
    continue when not exists (select 1 from public.profiles where id = u and not is_suspended);
    continue when public.is_blocked_between(me, u);
    continue when exists (select 1 from public.conversation_members where conversation_id = conv and user_id = u);
    continue when not (public.is_friend(me, u) or exists (select 1 from public.profiles where id = u and who_can_message = 'anyone'));
    insert into public.conversation_members (conversation_id, user_id, role) values (conv, u, 'member');
    select display_name into nm from public.profiles where id = u;
    perform public.orvix_group_log_add(conv, 'add', u, 'menambahkan ' || coalesce(nm, 'anggota'));
    added := added + 1;
  end loop;
  return added;
end $$;

create or replace function public.orvix_group_remove_member(conv uuid, uid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); mr text := public.orvix_group_role(conv, auth.uid()); tr text := public.orvix_group_role(conv, uid); nm text;
begin
  if mr not in ('owner','admin') then raise exception 'Hanya admin grup'; end if;
  if uid = me then raise exception 'Gunakan Keluar grup'; end if;
  if tr is null then raise exception 'Bukan anggota grup'; end if;
  if tr = 'owner' or (tr = 'admin' and mr <> 'owner') then raise exception 'Tidak punya izin mengeluarkan anggota ini'; end if;
  select display_name into nm from public.profiles where id = uid;
  delete from public.conversation_members where conversation_id = conv and user_id = uid;
  perform public.orvix_group_log_add(conv, 'remove', uid, 'mengeluarkan ' || coalesce(nm, 'anggota'));
end $$;

create or replace function public.orvix_group_set_role(conv uuid, uid uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
declare tr text := public.orvix_group_role(conv, uid); nm text;
begin
  if public.orvix_group_role(conv, auth.uid()) <> 'owner' then raise exception 'Hanya pemilik grup yang bisa mengatur admin'; end if;
  if p_role not in ('admin','member') then raise exception 'Peran tidak valid'; end if;
  if tr is null then raise exception 'Bukan anggota grup'; end if;
  if tr = 'owner' then raise exception 'Peran pemilik tidak bisa diubah'; end if;
  if tr = p_role then return; end if;
  select display_name into nm from public.profiles where id = uid;
  update public.conversation_members set role = p_role where conversation_id = conv and user_id = uid;
  perform public.orvix_group_log_add(conv, case when p_role = 'admin' then 'promote' else 'demote' end, uid,
    case when p_role = 'admin' then 'menjadikan ' || coalesce(nm, 'anggota') || ' admin' else 'mencabut admin ' || coalesce(nm, 'anggota') end);
end $$;

-- 10) Keluar grup: kepemilikan dialihkan otomatis agar grup tidak tanpa pemilik --------------------------
create or replace function public.leave_group(conv uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r text; nxt uuid;
begin
  if not exists (select 1 from public.conversations where id = conv and type = 'group') then raise exception 'Bukan grup'; end if;
  r := public.orvix_group_role(conv, auth.uid());
  if r is null then return; end if;
  delete from public.conversation_members where conversation_id = conv and user_id = auth.uid();
  if not exists (select 1 from public.conversation_members where conversation_id = conv) then
    delete from public.conversations where id = conv; return;
  end if;
  if r = 'owner' then
    select user_id into nxt from public.conversation_members where conversation_id = conv
      order by (role = 'admin') desc, joined_at asc limit 1;
    update public.conversation_members set role = 'owner' where conversation_id = conv and user_id = nxt;
    insert into public.orvix_group_log (conversation_id, actor_id, target_id, action) values (conv, auth.uid(), nxt, 'owner');
  end if;
  insert into public.orvix_group_log (conversation_id, actor_id, target_id, action) values (conv, auth.uid(), auth.uid(), 'leave');
end $$;

-- 11) Hapus grup (khusus pemilik; menghapus untuk semua anggota) ---------------------------------------
create or replace function public.orvix_group_delete(conv uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.orvix_group_role(conv, auth.uid()) <> 'owner' then raise exception 'Hanya pemilik grup yang bisa menghapus grup'; end if;
  delete from public.conversations where id = conv and type = 'group';
end $$;

-- 12) Riwayat perubahan anggota (dengan nama) --------------------------------------------------------------
create or replace function public.orvix_group_changes(conv uuid, lim integer default 50)
returns table (id bigint, action text, actor_name text, target_name text, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_member(conv) then raise exception 'Bukan anggota'; end if;
  return query select l.id, l.action, a.display_name, t.display_name, l.created_at
    from public.orvix_group_log l left join public.profiles a on a.id = l.actor_id left join public.profiles t on t.id = l.target_id
    where l.conversation_id = conv and l.action in ('add','remove','leave','promote','demote','owner')
    order by l.created_at desc limit least(greatest(lim, 1), 100);
end $$;

-- 13) Hak eksekusi: hanya pengguna masuk ------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array[
    'orvix_group_overview(uuid)', 'orvix_group_update_info(uuid,text,text,text,boolean)', 'orvix_group_set_policy(uuid,text,text)',
    'orvix_group_add_members(uuid,uuid[])', 'orvix_group_remove_member(uuid,uuid)', 'orvix_group_set_role(uuid,uuid,text)',
    'leave_group(uuid)', 'orvix_group_delete(uuid)', 'orvix_group_changes(uuid,integer)']
  loop execute format('revoke execute on function public.%s from public, anon', f); execute format('grant execute on function public.%s to authenticated', f); end loop;
end $$;
