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
