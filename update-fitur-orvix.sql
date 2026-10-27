-- ORVIX BAGIAN 12a: Info profil, izin chat via ID ORVIX, preferensi tema
-- Aman dijalankan ulang. Tidak menghapus data lama.

-- 1) Kolom pengaturan baru di profiles (default aman: hanya teman boleh chat; tema ORVIX)
alter table public.profiles add column if not exists who_can_message text not null default 'friends';
alter table public.profiles drop constraint if exists profiles_who_can_message_check;
alter table public.profiles add constraint profiles_who_can_message_check check (who_can_message in ('anyone','friends'));

alter table public.profiles add column if not exists theme text not null default 'orvix';
alter table public.profiles drop constraint if exists profiles_theme_check;
alter table public.profiles add constraint profiles_theme_check check (theme in ('orvix','brutal','glass'));

-- Hanya pemilik akun yang bisa mengubah (policy profiles_update: id = auth.uid()); kolom sensitif tetap tak bisa diubah klien
grant select (who_can_message, theme) on public.profiles to authenticated;
grant update (who_can_message, theme) on public.profiles to authenticated;

-- 2) Info/Tentang Saya = kolom status_text yang sudah ada (tidak membuat kolom duplikat).
--    Trigger: rapikan spasi, kosong -> NULL, batas 139 karakter (hanya dicek bila isinya diubah).
create or replace function public.orvix_bio_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.status_text is distinct from old.status_text then
    new.status_text := nullif(btrim(coalesce(new.status_text, '')), '');
    if new.status_text is not null and char_length(new.status_text) > 139 then
      raise exception 'Info maksimal 139 karakter';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_orvix_bio_guard on public.profiles;
create trigger trg_orvix_bio_guard before insert or update on public.profiles
  for each row execute function public.orvix_bio_guard();

-- 3) Pembuka chat pribadi (internal). Satu-satunya jalur membuat percakapan pribadi.
create or replace function public.orvix_open_direct(me uuid, target uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare k text; cid uuid; pol text;
begin
  if me is null or target is null or target = me then raise exception 'Permintaan tidak valid'; end if;
  if not exists (select 1 from public.profiles where id = me and not is_suspended) then raise exception 'Akun dinonaktifkan'; end if;
  select p.who_can_message into pol from public.profiles p where p.id = target and not p.is_suspended;
  if pol is null then raise exception 'Pengguna tidak ditemukan'; end if;
  if public.is_blocked_between(me, target) then raise exception 'Tidak dapat memulai chat dengan pengguna ini'; end if;   -- blokir selalu prioritas utama
  k := least(me, target)::text || '_' || greatest(me, target)::text;
  select id into cid from public.conversations where direct_key = k;
  if cid is not null then return cid; end if;                                    -- chat lama tetap bisa dibuka (tanpa duplikasi)
  if not public.is_friend(me, target) then
    if pol <> 'anyone' then
      raise exception 'Pengguna ini hanya menerima chat dari teman. Kirim permintaan pertemanan terlebih dahulu.' using hint = 'need_friend';
    end if;
    if (select count(*) from public.conversations c where c.created_by = me and c.type = 'direct'
          and c.created_at > now() - interval '1 day') >= 30 then
      raise exception 'Terlalu banyak chat baru hari ini. Coba lagi besok.';
    end if;
  end if;
  insert into public.conversations (type, created_by, direct_key) values ('direct', me, k)
    on conflict (direct_key) do nothing returning id into cid;
  if cid is null then
    select id into cid from public.conversations where direct_key = k;
  else
    insert into public.conversation_members (conversation_id, user_id, role) values (cid, me, 'member'), (cid, target, 'member');
  end if;
  return cid;
end $$;

create or replace function public.start_direct_chat(target uuid) returns uuid
language plpgsql security definer set search_path = public as $$
begin
  return public.orvix_open_direct(auth.uid(), target);
end $$;

revoke execute on function public.orvix_open_direct(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.orvix_bio_guard() from public, anon, authenticated;
revoke execute on function public.start_direct_chat(uuid) from public, anon;
grant execute on function public.start_direct_chat(uuid) to authenticated;
-- ORVIX BAGIAN 12b: status pesan (1 centang tersimpan, 2 centang diterima, 2 centang biru dibaca)
-- Memakai ulang tabel message_reads (last_read_at = dibaca). Ditambah last_delivered_at = diterima perangkat penerima.

alter table public.message_reads add column if not exists last_delivered_at timestamptz;

-- Anggota percakapan boleh MELIHAT status anggota lain; menulis hanya lewat RPC (anti-pemalsuan)
drop policy if exists message_reads_select on public.message_reads;
create policy message_reads_select on public.message_reads for select to authenticated
  using (public.is_member(conversation_id));
grant select on public.message_reads to authenticated;

do $$ begin
  alter publication supabase_realtime add table public.message_reads;
exception when duplicate_object then null; end $$;

-- Dibaca: hanya pemanggil sendiri (auth.uid()), dan otomatis juga tercatat "diterima"
create or replace function public.mark_read(conv uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member(conv) then raise exception 'Bukan anggota'; end if;
  insert into public.message_reads (conversation_id, user_id, last_read_at, last_delivered_at)
    values (conv, auth.uid(), now(), now())
    on conflict (conversation_id, user_id) do update
      set last_read_at = now(), last_delivered_at = now();
end $$;

-- Diterima: dipanggil klien penerima saat pesan benar-benar sampai di perangkatnya. Tidak menandai dibaca.
create or replace function public.orvix_mark_delivered(conv uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member(conv) then raise exception 'Bukan anggota'; end if;
  insert into public.message_reads (conversation_id, user_id, last_read_at, last_delivered_at)
    values (conv, auth.uid(), '-infinity'::timestamptz, now())
    on conflict (conversation_id, user_id) do update set last_delivered_at = now();
end $$;

revoke execute on function public.mark_read(uuid), public.orvix_mark_delivered(uuid) from public, anon;
grant execute on function public.mark_read(uuid), public.orvix_mark_delivered(uuid) to authenticated;
-- ORVIX BAGIAN 12c: pesan sementara (Nonaktif, 24 jam, 7 hari, 90 hari)
-- Aturan: pengaturan hanya berlaku untuk PESAN BARU setelah diubah. Pesan lama tidak berubah.
-- Chat pribadi: kedua anggota boleh mengubah. Grup/saluran: hanya pemilik. Anggota diberi tahu lewat pesan sistem.

alter table public.conversations add column if not exists disappear_secs integer;
alter table public.conversations drop constraint if exists conversations_disappear_check;
alter table public.conversations add constraint conversations_disappear_check
  check (disappear_secs is null or disappear_secs in (86400, 604800, 7776000));
alter table public.conversations add column if not exists disappear_changed_at timestamptz;
alter table public.conversations add column if not exists disappear_changed_by uuid references public.profiles(id) on delete set null;

alter table public.messages add column if not exists expires_at timestamptz;
create index if not exists messages_expires_idx on public.messages (expires_at) where expires_at is not null;
create index if not exists messages_media_path_idx on public.messages (media_path) where media_path is not null;

-- Jenis pesan 'system' (pemberitahuan pengaturan); hanya dibuat oleh fungsi database
alter table public.messages drop constraint if exists messages_message_type_check;
alter table public.messages add constraint messages_message_type_check check (message_type in ('text','image','video','system'));

-- expires_at diisi server saat pesan dibuat (klien tidak punya hak menulis kolom ini)
create or replace function public.orvix_msg_expiry() returns trigger
language plpgsql security definer set search_path = public as $$
declare d integer;
begin
  if new.message_type = 'system' then new.expires_at := null; return new; end if;
  select c.disappear_secs into d from public.conversations c where c.id = new.conversation_id;
  if d is not null then new.expires_at := coalesce(new.created_at, now()) + make_interval(secs => d); end if;
  return new;
end $$;
drop trigger if exists trg_orvix_msg_expiry on public.messages;
create trigger trg_orvix_msg_expiry before insert on public.messages
  for each row execute function public.orvix_msg_expiry();

-- Pesan kedaluwarsa tidak lagi bisa dibaca lewat RLS (bukan sekadar disembunyikan di frontend)
drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages for select to authenticated
  using (public.is_member(conversation_id) and (expires_at is null or expires_at > now()));

-- Pelindung pesan: versi asli + pesan sistem tidak bisa diedit/dihapus pengguna
create or replace function public.messages_guard() returns trigger
language plpgsql as $$
begin
  if auth.uid() is null then return new; end if;   -- service role / SQL editor
  if old.message_type = 'system' then raise exception 'Pesan sistem tidak dapat diubah'; end if;
  if new.conversation_id <> old.conversation_id or new.sender_id <> old.sender_id
     or new.created_at <> old.created_at or new.message_type <> old.message_type then
    raise exception 'Kolom pesan ini tidak dapat diubah';
  end if;
  if old.deleted_at is not null then raise exception 'Pesan sudah dihapus'; end if;
  if new.deleted_at is not null then
    new.deleted_at := now(); new.content := '';
  elsif new.content is distinct from old.content then
    if now() - old.created_at > interval '15 minutes' then raise exception 'Batas waktu edit pesan 15 menit'; end if;
    if char_length(btrim(new.content)) < 1 then raise exception 'Pesan tidak boleh kosong'; end if;
    new.edited_at := now();
  end if;
  return new;
end $$;

-- Mengubah durasi (0 = nonaktif)
create or replace function public.orvix_set_disappearing(conv uuid, secs integer) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); c public.conversations; v integer := nullif(secs, 0); label text;
begin
  if me is null then raise exception 'Belum login'; end if;
  if v is not null and v not in (86400, 604800, 7776000) then raise exception 'Durasi tidak valid'; end if;
  select * into c from public.conversations where id = conv;
  if not found or not public.is_member(conv) then raise exception 'Percakapan tidak ditemukan'; end if;
  if c.type = 'direct' then
    if public.is_blocked_between(me, (select user_id from public.conversation_members where conversation_id = conv and user_id <> me limit 1)) then
      raise exception 'Tidak dapat mengubah pengaturan'; end if;
  elsif not exists (select 1 from public.conversation_members where conversation_id = conv and user_id = me and role = 'owner') then
    raise exception 'Hanya pemilik yang dapat mengubah pesan sementara';
  end if;
  if c.disappear_secs is not distinct from v then return; end if;
  update public.conversations set disappear_secs = v, disappear_changed_at = now(), disappear_changed_by = me where id = conv;
  label := case v when 86400 then '24 jam' when 604800 then '7 hari' when 7776000 then '90 hari' end;
  insert into public.messages (conversation_id, sender_id, content, message_type)
    values (conv, me, case when v is null then 'menonaktifkan pesan sementara.'
                           else 'mengaktifkan pesan sementara (' || label || '). Hanya berlaku untuk pesan baru.' end, 'system');
end $$;

-- Daftar chat: abaikan pesan kedaluwarsa dan pesan sistem pada pratinjau & hitungan belum dibaca
drop function if exists public.list_my_conversations();
create function public.list_my_conversations()
returns table (conv_id uuid, conv_type text, title text, other_id uuid, other_username text, other_name text,
               other_avatar text, other_verified boolean, last_content text, last_at timestamptz,
               last_sender uuid, last_deleted boolean, unread bigint, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select c.id, c.type, c.title, o.id, o.username, o.display_name, o.avatar_url, o.is_verified,
         lm.content, lm.created_at, lm.sender_id, (lm.deleted_at is not null),
         (select count(*) from public.messages m where m.conversation_id = c.id and m.sender_id <> auth.uid()
            and m.deleted_at is null and m.message_type <> 'system' and (m.expires_at is null or m.expires_at > now())
            and m.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)),
         c.created_at
  from public.conversations c
  join public.conversation_members me on me.conversation_id = c.id and me.user_id = auth.uid()
  left join public.message_reads r on r.conversation_id = c.id and r.user_id = auth.uid()
  left join lateral (
    select p.id, p.username, p.display_name, p.avatar_url, p.is_verified
    from public.conversation_members cm join public.profiles p on p.id = cm.user_id
    where cm.conversation_id = c.id and cm.user_id <> auth.uid() and c.type = 'direct' limit 1) o on true
  left join lateral (
    select m.content, m.created_at, m.sender_id, m.deleted_at from public.messages m
    where m.conversation_id = c.id and m.message_type <> 'system' and (m.expires_at is null or m.expires_at > now())
    order by m.created_at desc limit 1) lm on true
  order by coalesce(lm.created_at, c.created_at) desc
$$;

-- Berkas lampiran kedaluwarsa tidak bisa lagi diminta URL baru-nya lewat Storage
drop policy if exists chatmedia_select on storage.objects;
create policy chatmedia_select on storage.objects for select to authenticated
  using (bucket_id = 'chat-media' and public.is_member(((storage.foldername(name))[1])::uuid)
         and not exists (select 1 from public.messages m
                         where m.media_path = name and m.expires_at is not null and m.expires_at <= now()));

-- Pembersihan baris tanpa lampiran (fallback pg_cron). Lampiran dibersihkan oleh Edge Function purge-expired.
create or replace function public.orvix_purge_expired_text() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from public.messages where id in (
    select id from public.messages where expires_at <= now() and media_path is null limit 1000);
  get diagnostics n = row_count; return n;
end $$;

revoke execute on function public.orvix_msg_expiry(), public.orvix_purge_expired_text() from public, anon, authenticated;
revoke execute on function public.orvix_set_disappearing(uuid, integer), public.list_my_conversations() from public, anon;
grant execute on function public.orvix_set_disappearing(uuid, integer), public.list_my_conversations() to authenticated;
-- ORVIX BAGIAN 12d: balas story ke chat pribadi + repost story dengan izin pemilik
-- Catatan: kolom media_type/thumb_path/duration_ms dipakai aplikasi sejak fitur video story. Perintah di bawah
-- hanya menambahkannya bila belum ada (tidak mengubah kolom yang sudah ada).

alter table public.stories add column if not exists media_type text;
alter table public.stories add column if not exists thumb_path text;
alter table public.stories add column if not exists duration_ms integer;

-- ---------- REPLY STORY ----------
alter table public.messages add column if not exists story_id uuid;          -- tanpa FK: pesan tetap ada walau story dihapus
alter table public.messages add column if not exists story_owner_id uuid;
alter table public.messages add column if not exists story_text text;        -- cuplikan teks saja; media TIDAK disalin
alter table public.messages add column if not exists story_kind text;
alter table public.messages add column if not exists story_bg smallint;
create index if not exists messages_story_idx on public.messages (story_id) where story_id is not null;

create or replace function public.orvix_reply_story(p_story uuid, p_text text)
returns table (conv_id uuid, message_id uuid)
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); s public.stories; txt text := btrim(coalesce(p_text, '')); cid uuid; mid uuid;
begin
  if me is null then raise exception 'Belum login'; end if;
  if char_length(txt) not between 1 and 1000 then raise exception 'Balasan 1-1000 karakter'; end if;
  select * into s from public.stories where id = p_story and expires_at > now();
  if not found then raise exception 'Story sudah tidak tersedia'; end if;
  if s.user_id = me then raise exception 'Tidak bisa membalas story sendiri'; end if;
  if not public.can_view_story(s.user_id, s.visibility) then raise exception 'Kamu tidak punya akses ke story ini'; end if;   -- cek privasi + blokir
  cid := public.orvix_open_direct(me, s.user_id);        -- menghormati izin chat penerima, blokir, dan tanpa percakapan ganda
  insert into public.messages (conversation_id, sender_id, content, message_type, story_id, story_owner_id, story_text, story_kind, story_bg)
    values (cid, me, txt, 'text', s.id, s.user_id, nullif(left(coalesce(s.content, ''), 120), ''),
            case when s.media_path is null then 'text' else coalesce(s.media_type, 'image') end, s.bg_index)
    returning id into mid;
  return query select cid, mid;
end $$;

-- Status sumber story untuk pratinjau di chat: hanya baris yang MASIH ada, belum kedaluwarsa, dan boleh dilihat pemanggil.
-- Story yang hilang/kedaluwarsa tidak muncul -> klien tidak menampilkan medianya lagi.
create or replace function public.orvix_story_status(ids uuid[])
returns table (id uuid, kind text, content text, bg_index smallint, media_path text, thumb_path text, owner_name text, owner_username text)
language sql stable security definer set search_path = public as $$
  select s.id, case when s.media_path is null then 'text' else coalesce(s.media_type, 'image') end,
         s.content, s.bg_index, s.media_path, s.thumb_path, p.display_name, p.username
  from public.stories s join public.profiles p on p.id = s.user_id
  where s.id = any(ids[1:50]) and s.expires_at > now() and public.can_view_story(s.user_id, s.visibility)
$$;

-- ---------- REPOST STORY ----------
alter table public.stories add column if not exists allow_repost boolean not null default false;
alter table public.stories add column if not exists repost_of uuid references public.stories(id) on delete cascade;   -- sumber dihapus -> repost ikut hilang
alter table public.stories add column if not exists repost_owner_id uuid;
create unique index if not exists stories_repost_uq on public.stories (user_id, repost_of) where repost_of is not null;
alter table public.stories drop constraint if exists stories_repost_perm_check;
alter table public.stories add constraint stories_repost_perm_check check (not allow_repost or visibility = 'public');
grant insert (allow_repost) on public.stories to authenticated;   -- repost_of/repost_owner_id TIDAK diberikan ke klien

create or replace function public.orvix_repost_story(p_story uuid, p_visibility text default 'friends') returns uuid
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); s public.stories; nid uuid;
begin
  if me is null or not exists (select 1 from public.profiles where id = me and not is_suspended) then raise exception 'Belum login'; end if;
  if p_visibility not in ('friends','public','only_me') then raise exception 'Visibilitas tidak valid'; end if;
  select * into s from public.stories where id = p_story and expires_at > now() and repost_of is null;
  if not found then raise exception 'Story sudah tidak tersedia'; end if;
  if s.user_id = me then raise exception 'Tidak bisa repost story sendiri'; end if;
  if not s.allow_repost or s.visibility <> 'public' then raise exception 'Pemilik tidak mengizinkan repost story ini'; end if;
  if not public.can_view_story(s.user_id, s.visibility) then raise exception 'Kamu tidak punya akses ke story ini'; end if;   -- blokir & privasi
  if exists (select 1 from public.stories where user_id = me and repost_of = s.id) then raise exception 'Kamu sudah mereposting story ini'; end if;
  insert into public.stories (user_id, content, media_path, bg_index, visibility, expires_at, media_type, thumb_path, duration_ms,
                              allow_repost, repost_of, repost_owner_id)
    values (me, s.content, s.media_path, s.bg_index, p_visibility, s.expires_at, s.media_type, s.thumb_path, s.duration_ms,
            false, s.id, s.user_id)       -- berkas media dipakai bersama (tanpa duplikasi); masa tayang mengikuti sumber
    returning id into nid;
  return nid;
end $$;

-- Atribusi repost + status izin untuk daftar story (melengkapi story_feed tanpa mengubahnya)
create or replace function public.orvix_story_extras(ids uuid[])
returns table (id uuid, allow_repost boolean, repost_of uuid, orig_name text, orig_username text, orig_verified boolean, reposted_by_me boolean)
language sql stable security definer set search_path = public as $$
  select s.id, s.allow_repost, s.repost_of, o.display_name, o.username, coalesce(o.is_verified, false),
         exists (select 1 from public.stories r where r.user_id = auth.uid() and r.repost_of = s.id)
  from public.stories s left join public.profiles o on o.id = s.repost_owner_id
  where s.id = any(ids[1:200]) and s.expires_at > now() and public.can_view_story(s.user_id, s.visibility)
$$;

revoke execute on function public.orvix_reply_story(uuid, text), public.orvix_story_status(uuid[]),
  public.orvix_repost_story(uuid, text), public.orvix_story_extras(uuid[]) from public, anon;
grant execute on function public.orvix_reply_story(uuid, text), public.orvix_story_status(uuid[]),
  public.orvix_repost_story(uuid, text), public.orvix_story_extras(uuid[]) to authenticated;
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

-- ORVIX BAGIAN 12h: Banner profil
-- Aman dijalankan ulang. Tidak menghapus data lama.
-- File banner disimpan di bucket `avatars` (publik, maks. 2 MB) pada folder <user_id>/banner-*.webp,
-- jadi kebijakan Storage yang sudah ada (folder = auth.uid()) otomatis berlaku. Tidak perlu bucket baru.

alter table public.profiles add column if not exists banner_url text;

-- URL banner hanya boleh menunjuk ke folder milik pemilik akun sendiri (mencegah menempel URL orang lain / situs luar)
alter table public.profiles drop constraint if exists profiles_banner_url_check;
alter table public.profiles add constraint profiles_banner_url_check
  check (banner_url is null or (char_length(banner_url) <= 500
    and banner_url like ('%/storage/v1/object/public/avatars/' || id::text || '/banner-%')));

-- Pola yang sama seperti kolom pengaturan lain: pengguna terautentikasi boleh membaca; hanya pemilik (policy profiles_update) yang boleh mengubah
grant select (banner_url) on public.profiles to authenticated;
grant update (banner_url) on public.profiles to authenticated;
