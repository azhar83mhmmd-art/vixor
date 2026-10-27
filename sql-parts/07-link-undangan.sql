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
