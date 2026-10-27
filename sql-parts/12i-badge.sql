-- ORVIX BAGIAN 12i: Sistem badge (Verified, ORVIX Premium, Creator, Business, Official)
-- Aman dijalankan ulang. Jalankan SETELAH 12f. Tidak menghapus data lama.
-- Kolom badge TIDAK diberi hak update ke klien: hanya fungsi security definer di bawah (dan service_role untuk Premium) yang bisa mengubahnya.

alter table public.profiles add column if not exists is_creator boolean not null default false;
alter table public.profiles add column if not exists is_business boolean not null default false;
alter table public.profiles add column if not exists is_official boolean not null default false;
alter table public.profiles add column if not exists premium_until timestamptz;       -- diisi hanya oleh backend tepercaya (webhook pembayaran / service_role)
alter table public.profiles add column if not exists is_super_admin boolean not null default false;   -- "admin utama"; set manual lewat SQL Editor

grant select (is_creator, is_business, is_official, premium_until) on public.profiles to authenticated;

-- Pengajuan boleh untuk 3 jenis badge
alter table public.verification_requests drop constraint if exists verification_requests_kind_check;
alter table public.verification_requests add constraint verification_requests_kind_check check (kind in ('verified','creator','business'));

create or replace function public.is_super_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_super_admin and role = 'admin' and not is_suspended from public.profiles where id = auth.uid()), false)
$$;
grant execute on function public.is_super_admin() to authenticated;

-- (fungsi pengajuan diperbarui agar mendukung jenis 'verified'; approve memberi badge sesuai jenis, TIDAK otomatis memberi Verified)
create or replace function public.orvix_submit_verification(p_kind text, p_category text, p_description text, p_links text[], p_evidence text[])
returns uuid language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); rid uuid; l text; e text; lk text[] := coalesce(p_links, '{}'); ev text[] := coalesce(p_evidence, '{}'); lastrej timestamptz;
begin
  if me is null then raise exception 'Belum login'; end if;
  if not exists (select 1 from public.profiles where id = me and not is_suspended) then raise exception 'Akun dinonaktifkan'; end if;
  if p_kind not in ('verified','creator','business') then raise exception 'Jenis badge tidak valid'; end if;
  if exists (select 1 from public.profiles where id = me and ((p_kind = 'verified' and is_verified) or (p_kind = 'creator' and is_creator) or (p_kind = 'business' and is_business))) then raise exception 'Kamu sudah memiliki badge ini'; end if;
  if p_category not in ('konten','seni_musik','jurnalis_penulis','toko_bisnis','merek','organisasi','lainnya') then raise exception 'Kategori tidak valid'; end if;
  if char_length(btrim(coalesce(p_description, ''))) not between 20 and 1000 then raise exception 'Deskripsi 20-1000 karakter'; end if;
  if coalesce(array_length(lk, 1), 0) > 3 then raise exception 'Maksimal 3 tautan'; end if;
  foreach l in array lk loop
    if l !~ '^https?://[^\s]{3,300}$' then raise exception 'Tautan harus diawali http:// atau https://'; end if;
  end loop;
  if coalesce(array_length(ev, 1), 0) not between 1 and 5 then raise exception 'Unggah 1-5 berkas bukti'; end if;
  foreach e in array ev loop
    if e not like me::text || '/%' or char_length(e) > 300 or e like '%..%' then raise exception 'Berkas bukti tidak valid'; end if;
  end loop;
  if exists (select 1 from public.verification_requests where user_id = me and status in ('pending')) then
    raise exception 'Pengajuan sebelumnya masih ditinjau'; end if;
  select max(reviewed_at) into lastrej from public.verification_requests where user_id = me and status = 'rejected';
  if lastrej is not null and lastrej > now() - interval '30 days' then
    raise exception 'Pengajuan ditolak baru-baru ini. Kamu bisa mengajukan lagi setelah % .', to_char(lastrej + interval '30 days', 'DD-MM-YYYY'); end if;
  if (select count(*) from public.verification_requests where user_id = me and created_at > now() - interval '90 days') >= 4 then
    raise exception 'Batas pengajuan tercapai. Coba lagi nanti.'; end if;
  update public.verification_requests set status = 'superseded' where user_id = me and status = 'need_info';   -- jawaban atas permintaan info
  insert into public.verification_requests (user_id, kind, category, description, links, evidence_paths)
    values (me, p_kind, p_category, btrim(p_description), lk, ev) returning id into rid;
  return rid;
end $$;

create or replace function public.orvix_admin_review_verification(p_id uuid, p_decision text, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); v public.verification_requests; why text := nullif(btrim(coalesce(p_reason, '')), ''); uname text;
begin
  if not public.is_admin() then raise exception 'Akses ditolak'; end if;
  if p_decision not in ('approve','reject','need_info') then raise exception 'Keputusan tidak valid'; end if;
  if why is not null and char_length(why) > 500 then raise exception 'Alasan maksimal 500 karakter'; end if;
  select * into v from public.verification_requests where id = p_id for update;
  if not found then raise exception 'Pengajuan tidak ditemukan'; end if;
  if v.status not in ('pending','need_info') then raise exception 'Pengajuan ini sudah diproses'; end if;
  if p_decision in ('reject','need_info') and why is null then raise exception 'Alasan wajib diisi'; end if;
  select username into uname from public.profiles where id = v.user_id;

  if p_decision = 'approve' then
    update public.profiles set is_verified = is_verified or v.kind = 'verified', verified_at = case when v.kind = 'verified' then now() else verified_at end,
      is_creator = is_creator or v.kind = 'creator', is_business = is_business or v.kind = 'business' where id = v.user_id;
    update public.verification_requests set status = 'approved', reviewed_by = me, reviewed_at = now(), reject_reason = null, admin_note = why where id = p_id;
    insert into public.user_notices (user_id, kind, title, body) values (v.user_id, 'verification', 'Badge disetujui', 'Selamat! Pengajuan badge ' || v.kind || ' disetujui.');
  elsif p_decision = 'reject' then
    update public.verification_requests set status = 'rejected', reviewed_by = me, reviewed_at = now(), reject_reason = why where id = p_id;
    insert into public.user_notices (user_id, kind, title, body) values (v.user_id, 'verification', 'Verifikasi ditolak', left('Pengajuanmu ditolak. Alasan: ' || why, 600));
  else
    update public.verification_requests set status = 'need_info', reviewed_by = me, reviewed_at = now(), reject_reason = why where id = p_id;
    insert into public.user_notices (user_id, kind, title, body) values (v.user_id, 'verification', 'Verifikasi butuh informasi', left('Admin meminta informasi tambahan: ' || why, 600));
  end if;
  insert into public.admin_audit_logs (admin_id, action, target_user_id, details)
    values (me, 'verification_' || p_decision, v.user_id, jsonb_build_object('request_id', p_id, 'note', why, 'username', uname));
end $$;

-- Admin: beri / cabut badge creator, business, official (dan verified). Cabut wajib beri alasan. Official hanya admin utama.
create or replace function public.orvix_admin_set_badge(p_user uuid, p_badge text, p_value boolean, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); why text := nullif(btrim(coalesce(p_reason, '')), ''); uname text;
begin
  if not public.is_admin() then raise exception 'Akses ditolak'; end if;
  if p_badge not in ('verified','creator','business','official') then raise exception 'Badge tidak valid'; end if;
  if p_badge = 'official' and not public.is_super_admin() then raise exception 'Hanya admin utama yang boleh mengelola badge Official'; end if;
  if p_value is null then raise exception 'Nilai tidak valid'; end if;
  if not p_value and why is null then raise exception 'Alasan pencabutan wajib diisi'; end if;
  if why is not null and char_length(why) > 500 then raise exception 'Alasan maksimal 500 karakter'; end if;
  select username into uname from public.profiles where id = p_user;
  if uname is null then raise exception 'Pengguna tidak ditemukan'; end if;
  if p_badge = 'verified' then update public.profiles set is_verified = p_value, verified_at = case when p_value then now() else null end where id = p_user;
  elsif p_badge = 'creator' then update public.profiles set is_creator = p_value where id = p_user;
  elsif p_badge = 'business' then update public.profiles set is_business = p_value where id = p_user;
  else update public.profiles set is_official = p_value where id = p_user; end if;
  insert into public.admin_audit_logs (admin_id, action, target_user_id, details)
    values (me, case when p_value then 'badge_grant' else 'badge_revoke' end, p_user, jsonb_build_object('badge', p_badge, 'reason', why, 'username', uname));
  insert into public.user_notices (user_id, kind, title, body)
    values (p_user, 'verification', case when p_value then 'Badge diberikan' else 'Badge dicabut' end,
            case when p_value then 'Akunmu kini memiliki badge ' || p_badge || '.' else left('Badge ' || p_badge || ' dicabut. Alasan: ' || why, 600) end);
end $$;
revoke all on function public.orvix_admin_set_badge(uuid, text, boolean, text) from public, anon;
grant execute on function public.orvix_admin_set_badge(uuid, text, boolean, text) to authenticated;

-- Premium: HANYA service_role (webhook pembayaran / Edge Function). Tidak bisa dipanggil klien maupun admin lewat UI.
-- p_until null atau waktu lampau = Premium nonaktif. Klien menghitung aktif/tidak dari premium_until > now().
create or replace function public.orvix_set_premium(p_user uuid, p_until timestamptz) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set premium_until = p_until where id = p_user;
  insert into public.admin_audit_logs (admin_id, action, target_user_id, details)
    values (null, 'premium_set', p_user, jsonb_build_object('until', p_until));
end $$;
revoke all on function public.orvix_set_premium(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.orvix_set_premium(uuid, timestamptz) to service_role;
