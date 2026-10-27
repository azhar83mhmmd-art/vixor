-- ORVIX BAGIAN 12g: daftar kontak teman (diturunkan dari tabel friendships; tidak ada tabel kontak kedua)
create or replace function public.orvix_list_contacts(p_q text default '', p_sort text default 'name', p_limit integer default 20, p_offset integer default 0)
returns table (friendship_id uuid, user_id uuid, orvix_id text, username text, display_name text, avatar_url text, status_text text,
               is_verified boolean, last_seen_at timestamptz, conv_id uuid, last_activity timestamptz, total bigint)
language sql stable security definer set search_path = public as $$
  select f.id, p.id, p.orvix_id, p.username, p.display_name, p.avatar_url, p.status_text, p.is_verified,
         case when p.show_last_seen then p.last_seen_at end,                      -- last seen mengikuti privasi pemilik akun
         c.id, lm.last_at, count(*) over ()
  from public.friendships f
  join public.profiles p on p.id = case when f.requester_id = auth.uid() then f.addressee_id else f.requester_id end
  left join public.conversations c on c.direct_key = least(auth.uid(), p.id)::text || '_' || greatest(auth.uid(), p.id)::text
  left join lateral (select max(m.created_at) as last_at from public.messages m
                     where m.conversation_id = c.id and m.message_type <> 'system' and (m.expires_at is null or m.expires_at > now())) lm on true
  where auth.uid() is not null and f.status = 'accepted'                          -- hanya pertemanan diterima, bukan pending
    and (f.requester_id = auth.uid() or f.addressee_id = auth.uid())
    and not p.is_suspended and not public.is_blocked_between(auth.uid(), p.id)
    and (btrim(coalesce(p_q, '')) = ''
         or position(lower(btrim(p_q)) in lower(p.display_name)) > 0
         or position(lower(btrim(p_q)) in lower(p.username)) > 0
         or p.orvix_id like btrim(p_q) || '%')
  order by (case when p_sort = 'activity' then coalesce(lm.last_at, '-infinity'::timestamptz) end) desc nulls last, lower(p.display_name) asc
  limit least(greatest(coalesce(p_limit, 20), 1), 50) offset greatest(coalesce(p_offset, 0), 0)
$$;
revoke execute on function public.orvix_list_contacts(text, text, integer, integer) from public, anon;
grant execute on function public.orvix_list_contacts(text, text, integer, integer) to authenticated;
