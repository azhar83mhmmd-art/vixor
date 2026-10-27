-- ORVIX BAGIAN 12e: laporan & moderasi (memperluas tabel reports yang sudah ada; sistem lama tetap jalan)
-- Status DB: open=Baru, reviewing=Ditinjau, need_info=Membutuhkan informasi, resolved=Selesai, dismissed=Ditolak.

-- 1) Longgarkan CHECK lama (reason & status) dengan aman, lalu pasang yang baru
do $$ declare r record; begin
  for r in select conname from pg_constraint
           where conrelid = 'public.reports'::regclass and contype = 'c'
             and (pg_get_constraintdef(oid) ilike '%reason%' or pg_get_constraintdef(oid) ilike '%status%')
  loop execute format('alter table public.reports drop constraint %I', r.conname); end loop;
end $$;
alter table public.reports add constraint reports_reason_check
  check (reason in ('spam','scam','doxxing','abuse','threat','inappropriate','impersonation','other'));
alter table public.reports add constraint reports_status_check
  check (status in ('open','reviewing','need_info','resolved','dismissed'));

alter table public.reports add column if not exists message_id uuid;            -- referensi pesan bukti (tanpa FK)
alter table public.reports add column if not exists message_snapshot text;      -- salinan teks pesan saat dilaporkan
alter table public.reports add column if not exists conversation_id uuid;
alter table public.reports add column if not exists admin_note text;
alter table public.reports add column if not exists updated_at timestamptz not null default now();

-- 2) Cegah duplikasi (satu laporan aktif per pelapor-target) dan banjir laporan
do $$ begin
  create unique index if not exists reports_active_uq on public.reports (reporter_id, reported_user_id)
    where status in ('open','reviewing','need_info');
exception when others then
  raise notice 'Index anti-duplikat dilewati karena data lama berisi laporan ganda; trigger di bawah tetap berlaku.';
end $$;

create or replace function public.orvix_reports_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if (select count(*) from public.reports r where r.reporter_id = new.reporter_id and r.created_at > now() - interval '1 day') >= 10 then
    raise exception 'Batas laporan harian tercapai. Coba lagi besok.';
  end if;
  return new;
end $$;
drop trigger if exists trg_orvix_reports_guard on public.reports;
create trigger trg_orvix_reports_guard before insert on public.reports for each row execute function public.orvix_reports_guard();

-- 3) Riwayat tindakan moderasi + pemberitahuan ke pengguna (tanpa akses langsung klien ke riwayat)
create table if not exists public.report_actions (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports(id) on delete cascade,
  admin_id uuid references public.profiles(id) on delete set null,
  action text not null,
  note text check (note is null or char_length(note) <= 500),
  created_at timestamptz not null default now()
);
create index if not exists report_actions_report_idx on public.report_actions (report_id, created_at);
alter table public.report_actions enable row level security;
revoke all on public.report_actions from anon, authenticated;   -- hanya lewat RPC admin

create table if not exists public.user_notices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null default 'info' check (kind in ('warning','info','verification')),
  title text not null check (char_length(title) <= 120),
  body text not null check (char_length(body) <= 600),
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists user_notices_user_idx on public.user_notices (user_id, read_at, created_at desc);
alter table public.user_notices enable row level security;
drop policy if exists user_notices_select on public.user_notices;
create policy user_notices_select on public.user_notices for select to authenticated using (user_id = auth.uid());
revoke all on public.user_notices from anon, authenticated;
grant select on public.user_notices to authenticated;

create or replace function public.orvix_ack_notices() returns void
language sql security definer set search_path = public as $$
  update public.user_notices set read_at = now() where user_id = auth.uid() and read_at is null
$$;

-- 4) Kirim laporan (validasi di database)
create or replace function public.orvix_submit_report(p_user uuid, p_reason text, p_details text default null, p_message uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); rid uuid; snap text; cv uuid; m public.messages;
begin
  if me is null then raise exception 'Belum login'; end if;
  if p_reason is null or p_reason not in ('spam','scam','doxxing','abuse','threat','inappropriate','impersonation','other') then
    raise exception 'Kategori laporan tidak valid'; end if;
  if p_user is null or p_user = me then raise exception 'Target laporan tidak valid'; end if;
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'Pengguna tidak ditemukan'; end if;
  if p_details is not null and char_length(p_details) > 1000 then raise exception 'Keterangan maksimal 1000 karakter'; end if;
  if p_reason = 'other' and char_length(btrim(coalesce(p_details, ''))) < 5 then raise exception 'Jelaskan alasan pada keterangan'; end if;
  if exists (select 1 from public.reports where reporter_id = me and reported_user_id = p_user and status in ('open','reviewing','need_info')) then
    raise exception 'Kamu sudah melaporkan pengguna ini dan laporannya masih diproses'; end if;
  if p_message is not null then
    select * into m from public.messages where id = p_message;
    if not found or m.sender_id <> p_user or not public.is_member(m.conversation_id) then
      raise exception 'Pesan bukti tidak valid'; end if;
    if m.deleted_at is not null then raise exception 'Pesan bukti sudah dihapus'; end if;
    snap := left(m.content, 500); cv := m.conversation_id;
  end if;
  insert into public.reports (reporter_id, reported_user_id, reason, details, message_id, message_snapshot, conversation_id)
    values (me, p_user, p_reason, nullif(btrim(coalesce(p_details, '')), ''), p_message, snap, cv) returning id into rid;
  return rid;
end $$;

-- 5) Admin Center: daftar laporan, tindakan (semua divalidasi di sini, bukan di frontend)
create or replace function public.orvix_admin_reports(p_status text default null, p_page integer default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare res jsonb; tot bigint; pg integer := greatest(coalesce(p_page, 0), 0);
begin
  if not public.is_admin() then raise exception 'Akses ditolak'; end if;
  select count(*) into tot from public.reports r where p_status is null or r.status = p_status;
  select jsonb_build_object('total', tot, 'pageSize', 20, 'reports', coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb)) into res
  from (
    select r.id, r.reason, r.details, r.status, r.created_at, r.reviewed_at, r.message_id, r.message_snapshot, r.admin_note,
           r.reported_user_id,
           jsonb_build_object('id', rp.id, 'username', rp.username, 'display_name', rp.display_name, 'is_suspended', rp.is_suspended, 'role', rp.role) as reported,
           jsonb_build_object('id', rr.id, 'username', rr.username, 'display_name', rr.display_name) as reporter,
           (select count(*) from public.reports o where o.reported_user_id = r.reported_user_id) as total_against,
           coalesce((select jsonb_agg(jsonb_build_object('action', a.action, 'note', a.note, 'at', a.created_at, 'admin', ad.username) order by a.created_at)
                     from public.report_actions a left join public.profiles ad on ad.id = a.admin_id where a.report_id = r.id), '[]'::jsonb) as history
    from public.reports r
    left join public.profiles rp on rp.id = r.reported_user_id
    left join public.profiles rr on rr.id = r.reporter_id
    where p_status is null or r.status = p_status
    order by r.created_at desc limit 20 offset pg * 20
  ) x;
  return res;
end $$;

create or replace function public.orvix_admin_report_action(p_id uuid, p_action text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); r public.reports; t public.profiles; note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not public.is_admin() then raise exception 'Akses ditolak'; end if;
  if p_action not in ('review','need_info','resolve','dismiss','warn','suspend','unsuspend') then raise exception 'Tindakan tidak valid'; end if;
  if note is not null and char_length(note) > 500 then raise exception 'Catatan maksimal 500 karakter'; end if;
  select * into r from public.reports where id = p_id; if not found then raise exception 'Laporan tidak ditemukan'; end if;
  select * into t from public.profiles where id = r.reported_user_id;
  if p_action in ('warn','suspend','dismiss','need_info') and note is null then raise exception 'Catatan/alasan wajib diisi untuk tindakan ini'; end if;
  if p_action in ('suspend','unsuspend') then
    if t.id is null then raise exception 'Akun target sudah tidak ada'; end if;
    if t.role = 'admin' or t.id = me then raise exception 'Akun admin tidak dapat ditangguhkan lewat laporan'; end if;
  end if;

  if p_action = 'warn' then
    insert into public.user_notices (user_id, kind, title, body)
      values (r.reported_user_id, 'warning', 'Peringatan dari moderator ORVIX', left(note, 600));
  elsif p_action = 'suspend' then
    update public.profiles set is_suspended = true where id = r.reported_user_id;
  elsif p_action = 'unsuspend' then
    update public.profiles set is_suspended = false where id = r.reported_user_id;
  end if;

  update public.reports set updated_at = now(), admin_note = coalesce(note, admin_note),
    status = case p_action when 'review' then 'reviewing' when 'need_info' then 'need_info' when 'resolve' then 'resolved'
                           when 'dismiss' then 'dismissed' when 'suspend' then 'resolved' when 'warn' then 'reviewing' else status end,
    reviewed_at = now(), reviewed_by = me
    where id = p_id;
  insert into public.report_actions (report_id, admin_id, action, note) values (p_id, me, p_action, note);
  insert into public.admin_audit_logs (admin_id, action, target_user_id, details)
    values (me, 'report_' || p_action, r.reported_user_id, jsonb_build_object('report_id', p_id, 'reason', r.reason, 'note', note, 'username', t.username));
end $$;

revoke execute on function public.orvix_reports_guard(), public.orvix_ack_notices() from public, anon, authenticated;
grant execute on function public.orvix_ack_notices() to authenticated;
revoke execute on function public.orvix_submit_report(uuid, text, text, uuid), public.orvix_admin_reports(text, integer),
  public.orvix_admin_report_action(uuid, text, text) from public, anon;
grant execute on function public.orvix_submit_report(uuid, text, text, uuid), public.orvix_admin_reports(text, integer),
  public.orvix_admin_report_action(uuid, text, text) to authenticated;
