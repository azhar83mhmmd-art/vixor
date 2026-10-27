-- ORVIX BAGIAN 16a: pesan lanjutan Premium (pesan terjadwal, draft per percakapan, pencarian lanjutan).
-- Aman dijalankan ulang. Butuh bagian 13d (orvix_is_premium) dan 13b (orvix_conv_prefs). Tidak mengubah tabel lama.
-- Pesan terjadwal DIKIRIM OLEH SERVER (pg_cron memanggil orvix_dispatch_scheduled tiap menit), bukan oleh browser.

-- ============ 1) Pesan terjadwal ============
create table if not exists public.orvix_scheduled_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  content text not null check (char_length(btrim(content)) between 1 and 4000),
  send_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled','sent','failed','cancelled')),
  error text,
  message_id uuid unique,                       -- pesan hasil kirim; UNIQUE = pengaman idempotensi
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists osm_due_idx on public.orvix_scheduled_messages (send_at) where status = 'scheduled';
create index if not exists osm_user_idx on public.orvix_scheduled_messages (user_id, send_at desc);

alter table public.orvix_scheduled_messages enable row level security;
drop policy if exists osm_select on public.orvix_scheduled_messages;
create policy osm_select on public.orvix_scheduled_messages for select to authenticated using (user_id = auth.uid());
revoke all on public.orvix_scheduled_messages from anon, authenticated;
grant select on public.orvix_scheduled_messages to authenticated;      -- tulis hanya lewat RPC di bawah

-- Versi can_send untuk pengguna tertentu (dipakai pekerja terjadwal yang tidak punya sesi auth.uid()).
create or replace function public.orvix_can_send_as(conv uuid, uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.conversation_members where conversation_id = conv and user_id = uid)
    and exists (select 1 from public.profiles where id = uid and not is_suspended)
    and (not exists (select 1 from public.conversations c where c.id = conv and c.type = 'channel')
         or exists (select 1 from public.conversation_members m where m.conversation_id = conv and m.user_id = uid and m.role = 'owner'))
    and not exists (
      select 1 from public.conversations c
      join public.conversation_members m on m.conversation_id = c.id and m.user_id <> uid
      where c.id = conv and c.type = 'direct' and public.is_blocked_between(uid, m.user_id))
$$;
revoke all on function public.orvix_can_send_as(uuid, uuid) from public, anon, authenticated;

-- Pemeriksaan bersama untuk buat/ubah jadwal.
create or replace function public.orvix__sched_check(p_conv uuid, p_content text, p_send_at timestamptz) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Belum masuk'; end if;
  if not public.orvix_is_premium(auth.uid()) then raise exception 'Pesan terjadwal khusus ORVIX Premium'; end if;
  if p_content is null or char_length(btrim(p_content)) not between 1 and 4000 then raise exception 'Pesan harus 1-4000 karakter'; end if;
  if p_send_at is null or p_send_at < now() + interval '30 seconds' then raise exception 'Waktu kirim harus di masa depan'; end if;
  if p_send_at > now() + interval '1 year' then raise exception 'Jadwal maksimal 1 tahun ke depan'; end if;
  if not public.can_send(p_conv) then raise exception 'Kamu tidak bisa mengirim ke percakapan ini'; end if;
end $$;
revoke all on function public.orvix__sched_check(uuid, text, timestamptz) from public, anon, authenticated;

create or replace function public.orvix_schedule_message(p_conv uuid, p_content text, p_send_at timestamptz) returns uuid
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); nid uuid;
begin
  perform public.orvix__sched_check(p_conv, p_content, p_send_at);
  if (select count(*) from public.orvix_scheduled_messages where user_id = me and status = 'scheduled') >= 30 then
    raise exception 'Maksimal 30 pesan terjadwal aktif. Batalkan atau tunggu ada yang terkirim.'; end if;
  insert into public.orvix_scheduled_messages (user_id, conversation_id, content, send_at)
    values (me, p_conv, btrim(p_content), p_send_at) returning id into nid;
  return nid;
end $$;

-- Ubah isi/waktu. Pesan yang gagal ikut diaktifkan kembali. Baris dikunci agar tidak bentrok dengan pekerja pengirim.
create or replace function public.orvix_update_scheduled(p_id uuid, p_content text, p_send_at timestamptz) returns void
language plpgsql security definer set search_path = public as $$
declare r public.orvix_scheduled_messages;
begin
  select * into r from public.orvix_scheduled_messages where id = p_id and user_id = auth.uid() for update;
  if not found then raise exception 'Pesan terjadwal tidak ditemukan'; end if;
  if r.status not in ('scheduled','failed') then raise exception 'Pesan ini sudah %', case r.status when 'sent' then 'terkirim' else 'dibatalkan' end; end if;
  perform public.orvix__sched_check(r.conversation_id, p_content, p_send_at);
  update public.orvix_scheduled_messages set content = btrim(p_content), send_at = p_send_at, status = 'scheduled', error = null, updated_at = now() where id = p_id;
end $$;

create or replace function public.orvix_cancel_scheduled(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.orvix_scheduled_messages set status = 'cancelled', updated_at = now() where id = p_id and user_id = auth.uid() and status in ('scheduled','failed');
  if not found then raise exception 'Pesan tidak bisa dibatalkan (sudah terkirim atau tidak ditemukan)'; end if;
end $$;

create or replace function public.orvix_delete_scheduled(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from public.orvix_scheduled_messages where id = p_id and user_id = auth.uid() and status <> 'scheduled';   -- yang masih aktif harus dibatalkan dulu
  if not found then raise exception 'Batalkan pesan terjadwal sebelum menghapusnya'; end if;
end $$;

-- Pekerja pengirim. Setiap baris diproses dalam sub-transaksi sendiri: kirim + tandai terkirim bersifat atomik,
-- baris dikunci (FOR UPDATE SKIP LOCKED) sehingga dua eksekusi bersamaan tidak mengirim ganda.
create or replace function public.orvix_dispatch_scheduled() returns integer
language plpgsql security definer set search_path = public as $$
declare r record; mid uuid; n integer := 0;
begin
  for r in select * from public.orvix_scheduled_messages where status = 'scheduled' and send_at <= now()
           order by send_at limit 100 for update skip locked
  loop
    begin
      if not public.orvix_is_premium(r.user_id) then raise exception 'Premium tidak aktif saat jadwal tiba'; end if;
      if not public.orvix_can_send_as(r.conversation_id, r.user_id) then raise exception 'Tidak lagi bisa mengirim ke percakapan ini'; end if;
      insert into public.messages (conversation_id, sender_id, content, message_type) values (r.conversation_id, r.user_id, r.content, 'text') returning id into mid;
      update public.orvix_scheduled_messages set status = 'sent', message_id = mid, sent_at = now(), updated_at = now(), error = null where id = r.id;
      n := n + 1;
    exception
      when sqlstate 'P0001' then update public.orvix_scheduled_messages set status = 'failed', error = left(sqlerrm, 160), updated_at = now() where id = r.id;
      when others then update public.orvix_scheduled_messages set status = 'failed', error = 'Gagal mengirim (galat sistem)', updated_at = now() where id = r.id;   -- sengaja tanpa sqlerrm: bisa memuat isi pesan
    end;
  end loop;
  -- rapikan riwayat lama (terkirim/dibatalkan > 30 hari) agar tabel tidak membengkak
  delete from public.orvix_scheduled_messages where status in ('sent','cancelled') and updated_at < now() - interval '30 days';
  return n;
end $$;
revoke all on function public.orvix_dispatch_scheduled() from public, anon, authenticated;   -- hanya pg_cron / service role

-- ============ 2) Draft per percakapan ============
create table if not exists public.orvix_drafts (
  user_id uuid not null references public.profiles(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  content text not null check (char_length(content) between 1 and 4000),
  updated_at timestamptz not null default now(),
  primary key (user_id, conversation_id)
);
alter table public.orvix_drafts enable row level security;
drop policy if exists od_select on public.orvix_drafts;
create policy od_select on public.orvix_drafts for select to authenticated using (user_id = auth.uid());
revoke all on public.orvix_drafts from anon, authenticated;
grant select on public.orvix_drafts to authenticated;

-- Simpan (atau hapus bila kosong). Hanya Premium aktif dan anggota percakapan.
create or replace function public.orvix_save_draft(p_conv uuid, p_content text) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'Belum masuk'; end if;
  if p_content is null or btrim(p_content) = '' then delete from public.orvix_drafts where user_id = me and conversation_id = p_conv; return; end if;
  if not public.orvix_is_premium(me) then raise exception 'Draft tersinkron khusus ORVIX Premium'; end if;
  if not public.is_member(p_conv) then raise exception 'Bukan anggota percakapan'; end if;
  if char_length(p_content) > 4000 then raise exception 'Draft terlalu panjang'; end if;
  insert into public.orvix_drafts (user_id, conversation_id, content) values (me, p_conv, p_content)
    on conflict (user_id, conversation_id) do update set content = excluded.content, updated_at = now();
end $$;

-- Daftar draft milik sendiri; kosong bila Premium berakhir (data tetap tersimpan, aktif lagi saat Premium diperpanjang).
create or replace function public.orvix_get_drafts() returns table(conversation_id uuid, content text, updated_at timestamptz)
language sql stable security definer set search_path = public as $$
  select d.conversation_id, d.content, d.updated_at from public.orvix_drafts d
  where d.user_id = auth.uid() and public.orvix_is_premium(auth.uid()) and public.is_member(d.conversation_id)
$$;

-- ============ 3) Pencarian lanjutan ============
-- SECURITY INVOKER: RLS messages_select (anggota + belum kedaluwarsa) tetap berlaku. Tanpa indeks baru.
-- Pengguna gratis: kata kunci di SATU percakapan. Premium: semua percakapan + filter pengirim, tanggal, jenis.
create or replace function public.orvix_search_messages(
  p_q text default null, p_conv uuid default null, p_sender uuid default null,
  p_since timestamptz default null, p_until timestamptz default null, p_kind text default null,
  p_before timestamptz default null, p_limit integer default 30)
returns table(id uuid, conversation_id uuid, sender_id uuid, content text, message_type text, created_at timestamptz)
language plpgsql stable security invoker set search_path = public as $$
declare me uuid := auth.uid(); q text := nullif(btrim(coalesce(p_q, '')), ''); lim integer := least(greatest(coalesce(p_limit, 30), 1), 50); since timestamptz := p_since;
begin
  if me is null then raise exception 'Belum masuk'; end if;
  if p_kind is not null and p_kind not in ('text','image','video') then raise exception 'Jenis konten tidak dikenal'; end if;
  if not public.orvix_is_premium(me) and (p_conv is null or p_sender is not null or p_since is not null or p_until is not null or p_kind is not null) then
    raise exception 'Pencarian lanjutan khusus ORVIX Premium'; end if;
  if q is null and p_sender is null and p_since is null and p_until is null and p_kind is null then raise exception 'Isi kata kunci atau pilih filter'; end if;
  if q is not null and char_length(q) < 2 then raise exception 'Kata kunci minimal 2 karakter'; end if;
  if p_conv is null and since is null then since := now() - interval '90 days'; end if;      -- batasi biaya pencarian lintas percakapan
  return query
    select m.id, m.conversation_id, m.sender_id, m.content, m.message_type, m.created_at
    from public.messages m
    left join public.orvix_conv_prefs pf on pf.conversation_id = m.conversation_id and pf.user_id = me
    where m.deleted_at is null and m.message_type <> 'system'
      and m.created_at > coalesce(pf.cleared_at, '-infinity'::timestamptz)
      and (p_conv is null or m.conversation_id = p_conv)
      and (p_sender is null or m.sender_id = p_sender)
      and (since is null or m.created_at >= since)
      and (p_until is null or m.created_at < p_until)
      and (p_kind is null or m.message_type = p_kind)
      and (p_before is null or m.created_at < p_before)
      and (q is null or m.content ilike '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%')
    order by m.created_at desc, m.id desc
    limit lim;
end $$;

-- ============ 4) Izin eksekusi ============
revoke all on function public.orvix_schedule_message(uuid, text, timestamptz), public.orvix_update_scheduled(uuid, text, timestamptz),
  public.orvix_cancel_scheduled(uuid), public.orvix_delete_scheduled(uuid), public.orvix_save_draft(uuid, text), public.orvix_get_drafts(),
  public.orvix_search_messages(text, uuid, uuid, timestamptz, timestamptz, text, timestamptz, integer) from public, anon;
grant execute on function public.orvix_schedule_message(uuid, text, timestamptz), public.orvix_update_scheduled(uuid, text, timestamptz),
  public.orvix_cancel_scheduled(uuid), public.orvix_delete_scheduled(uuid), public.orvix_save_draft(uuid, text), public.orvix_get_drafts(),
  public.orvix_search_messages(text, uuid, uuid, timestamptz, timestamptz, text, timestamptz, integer) to authenticated;

-- ============ 5) Penjadwal (pg_cron, tiap menit) ============
-- Jika extension belum aktif: Dashboard Supabase > Database > Extensions > aktifkan "pg_cron", lalu jalankan ulang blok ini.
do $$
begin
  create extension if not exists pg_cron;
  perform cron.unschedule('orvix-dispatch-scheduled') where exists (select 1 from cron.job where jobname = 'orvix-dispatch-scheduled');
  perform cron.schedule('orvix-dispatch-scheduled', '* * * * *', 'select public.orvix_dispatch_scheduled()');
exception when others then
  raise notice 'pg_cron belum aktif (%). Aktifkan extension pg_cron di Dashboard, lalu jalankan ulang bagian 5 file ini. Tanpa itu pesan terjadwal tidak akan terkirim.', sqlerrm;
end $$;
