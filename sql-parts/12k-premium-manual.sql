-- ORVIX BAGIAN 12k: Premium manual. Pengguna bayar ke admin; admin mengaktifkan Premium dengan masa aktif tertentu.
-- Jalankan setelah 12i. Aman dijalankan ulang. Klien biasa tetap TIDAK bisa mengubah premium_until.

-- Beri / perpanjang Premium: p_days 1..1825. Jika Premium masih aktif, masa aktif ditambahkan dari tanggal berakhirnya.
create or replace function public.orvix_admin_grant_premium(p_user uuid, p_days integer, p_note text default null) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); why text := nullif(btrim(coalesce(p_note, '')), ''); cur timestamptz; nxt timestamptz; uname text;
begin
  if not public.is_admin() then raise exception 'Akses ditolak'; end if;
  if p_days is null or p_days < 1 or p_days > 1825 then raise exception 'Durasi harus 1 sampai 1825 hari'; end if;
  if why is not null and char_length(why) > 500 then raise exception 'Catatan maksimal 500 karakter'; end if;
  select username, premium_until into uname, cur from public.profiles where id = p_user;
  if uname is null then raise exception 'Pengguna tidak ditemukan'; end if;
  nxt := greatest(coalesce(cur, now()), now()) + make_interval(days => p_days);
  update public.profiles set premium_until = nxt where id = p_user;
  insert into public.admin_audit_logs (admin_id, action, target_user_id, details)
    values (me, 'premium_grant', p_user, jsonb_build_object('days', p_days, 'until', nxt, 'note', why, 'username', uname));
  insert into public.user_notices (user_id, kind, title, body)
    values (p_user, 'info', 'ORVIX Premium aktif', 'Premium aktif sampai ' || to_char(nxt at time zone 'Asia/Jakarta', 'DD-MM-YYYY') || '. Terima kasih!');
  return nxt;
end $$;

create or replace function public.orvix_admin_revoke_premium(p_user uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); why text := nullif(btrim(coalesce(p_note, '')), ''); uname text;
begin
  if not public.is_admin() then raise exception 'Akses ditolak'; end if;
  if why is null then raise exception 'Alasan pencabutan wajib diisi'; end if;
  if char_length(why) > 500 then raise exception 'Catatan maksimal 500 karakter'; end if;
  select username into uname from public.profiles where id = p_user;
  if uname is null then raise exception 'Pengguna tidak ditemukan'; end if;
  update public.profiles set premium_until = null where id = p_user;
  insert into public.admin_audit_logs (admin_id, action, target_user_id, details)
    values (me, 'premium_revoke', p_user, jsonb_build_object('note', why, 'username', uname));
  insert into public.user_notices (user_id, kind, title, body)
    values (p_user, 'info', 'ORVIX Premium dihentikan', left('Premium dihentikan oleh admin. Alasan: ' || why, 600));
end $$;

revoke all on function public.orvix_admin_grant_premium(uuid, integer, text), public.orvix_admin_revoke_premium(uuid, text) from public, anon;
grant execute on function public.orvix_admin_grant_premium(uuid, integer, text), public.orvix_admin_revoke_premium(uuid, text) to authenticated;
