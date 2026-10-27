-- ORVIX BAGIAN 12f: pengajuan verifikasi kreator/bisnis (mengembangkan sistem centang biru yang sudah ada)
-- Lencana tetap berasal dari profiles.is_verified. Klien TIDAK punya hak mengubah kolom itu; hanya fungsi admin di bawah.

create table if not exists public.verification_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('creator','business')),
  category text not null check (category in ('konten','seni_musik','jurnalis_penulis','toko_bisnis','merek','organisasi','lainnya')),
  description text not null check (char_length(description) between 20 and 1000),
  links text[] not null default '{}' check (coalesce(array_length(links, 1), 0) <= 3),
  evidence_paths text[] not null default '{}' check (coalesce(array_length(evidence_paths, 1), 0) between 1 and 5),
  status text not null default 'pending' check (status in ('pending','approved','rejected','need_info','revoked','superseded')),
  reject_reason text check (reject_reason is null or char_length(reject_reason) <= 500),   -- tampil ke pemohon
  admin_note text check (admin_note is null or char_length(admin_note) <= 500),            -- internal
  reviewed_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);
create index if not exists verif_user_idx on public.verification_requests (user_id, created_at desc);
create index if not exists verif_status_idx on public.verification_requests (status, created_at);
create unique index if not exists verif_one_open_uq on public.verification_requests (user_id) where status in ('pending','need_info');

alter table public.verification_requests enable row level security;
drop policy if exists verif_select_own on public.verification_requests;
create policy verif_select_own on public.verification_requests for select to authenticated using (user_id = auth.uid());
revoke all on public.verification_requests from anon, authenticated;
grant select (id, user_id, kind, category, description, links, evidence_paths, status, reject_reason, created_at, reviewed_at)
  on public.verification_requests to authenticated;     -- admin_note tidak terlihat pemohon; tulis hanya lewat RPC

-- Bucket privat untuk bukti (gambar/PDF, maks 5 MB). Tidak pernah publik.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('verification-docs', 'verification-docs', false, 5242880, array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists verifdocs_insert on storage.objects;
create policy verifdocs_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'verification-docs' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists verifdocs_select on storage.objects;
create policy verifdocs_select on storage.objects for select to authenticated
  using (bucket_id = 'verification-docs' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));
drop policy if exists verifdocs_delete on storage.objects;
create policy verifdocs_delete on storage.objects for delete to authenticated
  using (bucket_id = 'verification-docs' and (storage.foldername(name))[1] = auth.uid()::text);

-- Pengajuan oleh pengguna
create or replace function public.orvix_submit_verification(p_kind text, p_category text, p_description text, p_links text[], p_evidence text[])
returns uuid language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); rid uuid; l text; e text; lk text[] := coalesce(p_links, '{}'); ev text[] := coalesce(p_evidence, '{}'); lastrej timestamptz;
begin
  if me is null then raise exception 'Belum login'; end if;
  if not exists (select 1 from public.profiles where id = me and not is_suspended) then raise exception 'Akun dinonaktifkan'; end if;
  if exists (select 1 from public.profiles where id = me and is_verified) then raise exception 'Akunmu sudah terverifikasi'; end if;
  if p_kind not in ('creator','business') then raise exception 'Jenis akun tidak valid'; end if;
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

-- Admin: daftar pengajuan
create or replace function public.orvix_admin_verifications(p_status text default 'pending', p_page integer default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare res jsonb; tot bigint; pg integer := greatest(coalesce(p_page, 0), 0);
begin
  if not public.is_admin() then raise exception 'Akses ditolak'; end if;
  if p_status = 'verified' then
    select count(*) into tot from public.profiles where is_verified;
    select jsonb_build_object('total', tot, 'pageSize', 20, 'verified', coalesce(jsonb_agg(jsonb_build_object(
        'user_id', p.id, 'username', p.username, 'display_name', p.display_name, 'orvix_id', p.orvix_id, 'verified_at', p.verified_at)
        order by p.verified_at desc nulls last), '[]'::jsonb)) into res
    from (select * from public.profiles where is_verified order by verified_at desc nulls last limit 20 offset pg * 20) p;
    return res;
  end if;
  select count(*) into tot from public.verification_requests v where p_status is null or v.status = p_status;
  select jsonb_build_object('total', tot, 'pageSize', 20, 'requests', coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb)) into res
  from (
    select v.id, v.user_id, v.kind, v.category, v.description, v.links, v.evidence_paths, v.status, v.reject_reason, v.admin_note, v.created_at, v.reviewed_at,
           jsonb_build_object('username', p.username, 'display_name', p.display_name, 'orvix_id', p.orvix_id, 'is_verified', p.is_verified, 'created_at', p.created_at) as profile,
           (select count(*) from public.reports r where r.reported_user_id = v.user_id) as reports_against
    from public.verification_requests v join public.profiles p on p.id = v.user_id
    where p_status is null or v.status = p_status
    order by v.created_at desc limit 20 offset pg * 20
  ) x;
  return res;
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
    update public.profiles set is_verified = true, verified_at = now() where id = v.user_id;
    update public.verification_requests set status = 'approved', reviewed_by = me, reviewed_at = now(), reject_reason = null, admin_note = why where id = p_id;
    insert into public.user_notices (user_id, kind, title, body) values (v.user_id, 'verification', 'Verifikasi disetujui', 'Selamat! Akunmu kini memiliki lencana terverifikasi ORVIX.');
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

create or replace function public.orvix_admin_revoke_verification(p_user uuid, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); uname text; why text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not public.is_admin() then raise exception 'Akses ditolak'; end if;
  select username into uname from public.profiles where id = p_user and is_verified;
  if uname is null then raise exception 'Pengguna tidak terverifikasi'; end if;
  update public.profiles set is_verified = false, verified_at = null where id = p_user;
  update public.verification_requests set status = 'revoked', reviewed_by = me, reviewed_at = now(), admin_note = why
    where user_id = p_user and status = 'approved';
  insert into public.user_notices (user_id, kind, title, body) values (p_user, 'verification', 'Verifikasi dicabut', 'Lencana terverifikasi pada akunmu telah dicabut oleh admin.');
  insert into public.admin_audit_logs (admin_id, action, target_user_id, details)
    values (me, 'verification_revoke', p_user, jsonb_build_object('note', why, 'username', uname));
end $$;

revoke execute on function public.orvix_submit_verification(text, text, text, text[], text[]), public.orvix_admin_verifications(text, integer),
  public.orvix_admin_review_verification(uuid, text, text), public.orvix_admin_revoke_verification(uuid, text) from public, anon;
grant execute on function public.orvix_submit_verification(text, text, text, text[], text[]), public.orvix_admin_verifications(text, integer),
  public.orvix_admin_review_verification(uuid, text, text), public.orvix_admin_revoke_verification(uuid, text) to authenticated;
