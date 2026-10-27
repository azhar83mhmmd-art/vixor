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
