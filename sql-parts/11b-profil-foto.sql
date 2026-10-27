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
