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
