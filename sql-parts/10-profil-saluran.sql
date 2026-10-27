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
