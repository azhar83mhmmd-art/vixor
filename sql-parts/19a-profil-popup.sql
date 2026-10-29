-- ORVIX BAGIAN 19a: popup profil dari ID ORVIX (8 angka). Idempotent, tidak menghapus data, tidak mengubah RLS lama.
-- Jalankan SETELAH 12a, 12h, 12i, 13a, 13d. Satu file per Run.

-- 1) Log pencarian untuk rate limit (hanya diakses fungsi security definer) ----------------------
create table if not exists public.orvix_lookup_log (
  user_id uuid not null references public.profiles(id) on delete cascade,
  at timestamptz not null default now()
);
create index if not exists orvix_lookup_log_idx on public.orvix_lookup_log (user_id, at desc);
alter table public.orvix_lookup_log enable row level security;       -- tanpa policy: klien tidak bisa baca/tulis
revoke all on public.orvix_lookup_log from anon, authenticated;

-- 2) Kartu profil publik (internal). Hanya kolom yang aman; tidak ada email, telepon, token. ------
create or replace function public.orvix_card(target uuid)
returns table (id uuid, orvix_id text, username text, display_name text, avatar_url text, banner_url text,
               bio text, is_verified boolean, is_creator boolean, is_business boolean, is_official boolean,
               premium_until timestamptz, last_seen_at timestamptz, relation text, can_message boolean)
language plpgsql stable security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then return; end if;
  return query
  select p.id, p.orvix_id, p.username, p.display_name,
         case when p.profile_public or public.shares_context(p.id) or p.id = me then p.avatar_url end,
         case when p.profile_public or public.shares_context(p.id) or p.id = me then p.banner_url end,
         case when p.profile_public or public.shares_context(p.id) or p.id = me then p.status_text end,
         p.is_verified, p.is_creator, p.is_business, p.is_official,
         case when p.premium_until > now() then p.premium_until end,
         case when p.show_last_seen and public.shares_context(p.id) then p.last_seen_at end,
         case when p.id = me then 'self'
              when public.is_friend(me, p.id) then 'friend'
              when exists (select 1 from public.friendships f where f.status = 'pending' and f.requester_id = me and f.addressee_id = p.id) then 'pending_out'
              when exists (select 1 from public.friendships f where f.status = 'pending' and f.addressee_id = me and f.requester_id = p.id) then 'pending_in'
              else 'none' end,
         (p.id <> me and (public.is_friend(me, p.id) or p.who_can_message = 'anyone'
            or exists (select 1 from public.conversations c where c.direct_key = least(me, p.id)::text || '_' || greatest(me, p.id)::text)))
  from public.profiles p
  where p.id = target and not p.is_suspended and not public.is_blocked_between(me, p.id);
end $$;
revoke execute on function public.orvix_card(uuid) from public, anon, authenticated;

-- 3) Pencarian dari teks ID (8 angka) atau @username: format dicek ketat, dibatasi 30 pencarian/menit/pengguna ---------------
create or replace function public.orvix_lookup_profile(q text)
returns table (id uuid, orvix_id text, username text, display_name text, avatar_url text, banner_url text,
               bio text, is_verified boolean, is_creator boolean, is_business boolean, is_official boolean,
               premium_until timestamptz, last_seen_at timestamptz, relation text, can_message boolean)
language plpgsql volatile security definer set search_path = public as $$
declare me uuid := auth.uid(); tid uuid; n int;
begin
  if me is null then raise exception 'Perlu masuk'; end if;
  if q is null or lower(btrim(q)) !~ '^([0-9]{8}|@[a-z0-9_]{3,20})$' then return; end if;   -- format bukan ID/username ORVIX: kosong, bukan galat
  delete from public.orvix_lookup_log where at < now() - interval '1 day' and user_id = me;
  select count(*) into n from public.orvix_lookup_log where user_id = me and at > now() - interval '1 minute';
  if n >= 30 then raise exception 'Terlalu banyak pencarian. Coba lagi sebentar.' using hint = 'rate_limit'; end if;
  insert into public.orvix_lookup_log (user_id) values (me);
  if left(btrim(q), 1) = '@' then select p.id into tid from public.profiles p where p.username = lower(substr(btrim(q), 2));
  else select p.id into tid from public.profiles p where p.orvix_id = btrim(q); end if;
  if tid is null then return; end if;
  return query select * from public.orvix_card(tid);                  -- tidak ketemu / diblokir / dinonaktifkan: hasil sama (kosong)
end $$;
revoke execute on function public.orvix_lookup_profile(text) from public, anon;
grant execute on function public.orvix_lookup_profile(text) to authenticated;

-- 4) Kartu dari user id (anggota grup, hasil cari, avatar di chat). UUID tidak bisa ditebak, tanpa rate limit.
create or replace function public.orvix_profile_card(target uuid)
returns table (id uuid, orvix_id text, username text, display_name text, avatar_url text, banner_url text,
               bio text, is_verified boolean, is_creator boolean, is_business boolean, is_official boolean,
               premium_until timestamptz, last_seen_at timestamptz, relation text, can_message boolean)
language sql stable security definer set search_path = public as $$
  select * from public.orvix_card(target)
$$;
revoke execute on function public.orvix_profile_card(uuid) from public, anon;
grant execute on function public.orvix_profile_card(uuid) to authenticated;
