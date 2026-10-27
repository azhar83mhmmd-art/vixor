-- ORVIX BAGIAN 13a: perbaikan fitur Blokir / Buka blokir.
-- Aman dijalankan ulang. Tidak membuat tabel baru, tidak mematikan RLS, tidak menghapus data.
-- Akar masalah yang diperbaiki:
--  1) Izin EXECUTE fungsi bisa hilang (mis. setelah supabase.sql dijalankan ulang) -> klien menerima "permission denied / function not found".
--  2) Daftar "Pengguna diblokir" bergantung pada RLS profiles; profil yang tidak lagi berbagi konteks (pertemanan dihapus saat blokir) tersembunyi.
--  3) Fungsi lama tidak memvalidasi login dan pesan galatnya tidak jelas.

grant select on public.blocked_users to authenticated;
drop policy if exists blocked_select on public.blocked_users;
create policy blocked_select on public.blocked_users for select to authenticated using (blocker_id = auth.uid());

create or replace function public.is_blocked_between(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.blocked_users
    where (blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a))
$$;

create or replace function public.block_user(target uuid) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'Sesi berakhir. Silakan masuk lagi.'; end if;
  if target is null or target = me then raise exception 'Tidak bisa memblokir diri sendiri'; end if;
  if not exists (select 1 from public.profiles where id = target) then raise exception 'Pengguna tidak ditemukan'; end if;
  insert into public.blocked_users (blocker_id, blocked_id) values (me, target)
    on conflict (blocker_id, blocked_id) do nothing;
  delete from public.friendships f
    where (f.requester_id = me and f.addressee_id = target) or (f.requester_id = target and f.addressee_id = me);
end $$;

create or replace function public.unblock_user(target uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sesi berakhir. Silakan masuk lagi.'; end if;
  delete from public.blocked_users where blocker_id = auth.uid() and blocked_id = target;
end $$;

-- Daftar yang SAYA blokir lengkap dengan profil (tidak terhalang RLS profiles)
create or replace function public.orvix_list_blocked()
returns table (user_id uuid, display_name text, username text, avatar_url text, is_verified boolean, blocked_at timestamptz)
language sql stable security definer set search_path = public as $$
  select b.blocked_id, p.display_name, p.username, p.avatar_url, p.is_verified, b.created_at
  from public.blocked_users b join public.profiles p on p.id = b.blocked_id
  where b.blocker_id = auth.uid() order by b.created_at desc
$$;

-- Pasang ulang izin eksekusi yang dipakai aplikasi (hanya fungsi yang memang ada)
do $$
declare s text;
begin
  foreach s in array array[
    'public.is_blocked_between(uuid, uuid)', 'public.block_user(uuid)', 'public.unblock_user(uuid)', 'public.orvix_list_blocked()',
    'public.is_member(uuid)', 'public.is_friend(uuid, uuid)', 'public.can_send(uuid)', 'public.shares_context(uuid)',
    'public.start_direct_chat(uuid)', 'public.list_my_conversations()', 'public.mark_read(uuid)'
  ] loop
    if to_regprocedure(s) is not null then
      execute format('revoke all on function %s from public, anon', s);
      execute format('grant execute on function %s to authenticated', s);
    end if;
  end loop;
end $$;
