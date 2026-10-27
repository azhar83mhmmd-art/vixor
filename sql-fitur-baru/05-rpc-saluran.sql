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
