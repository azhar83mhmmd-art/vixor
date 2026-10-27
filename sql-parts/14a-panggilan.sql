-- ORVIX BAGIAN 14a: Panggilan suara & video (pribadi + grup mesh), signaling lewat Realtime private Broadcast.
-- Idempotent, tidak menghapus tabel/data lama, tidak menyentuh autentikasi. Jalankan SETELAH 13a (is_blocked_between) dan supabase.sql.
-- Isi: tabel call_settings, calls, call_participants; RPC call_*; RLS; kebijakan realtime.messages; publikasi Realtime.
-- Yang TIDAK disimpan: audio/video, SDP, ICE candidate. Itu hanya lewat Broadcast (tidak ditulis ke tabel).

-- 1) Konfigurasi (satu baris). Ubah nilainya dengan UPDATE di SQL Editor, tanpa deploy ulang frontend.
create table if not exists public.call_settings (
  id int primary key default 1 check (id = 1),
  max_group_voice int not null default 8 check (max_group_voice between 2 and 20),
  max_group_video int not null default 4 check (max_group_video between 2 and 12),
  ring_timeout_secs int not null default 45 check (ring_timeout_secs between 15 and 120),
  max_starts_per_min int not null default 5 check (max_starts_per_min between 1 and 30),
  heartbeat_stale_secs int not null default 75 check (heartbeat_stale_secs between 30 and 300),
  allow_late_join boolean not null default true,
  keep_history boolean not null default true
);
insert into public.call_settings (id) values (1) on conflict (id) do nothing;

-- 2) Metadata panggilan
create table if not exists public.calls (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  kind text not null check (kind in ('voice','video')),
  scope text not null check (scope in ('direct','group')),
  created_by uuid references public.profiles(id) on delete set null,
  status text not null default 'ringing' check (status in ('ringing','active','ended')),
  end_reason text check (end_reason in ('completed','cancelled','declined','missed','failed','timeout','empty')),
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz
);
create index if not exists calls_conv_idx on public.calls (conversation_id, created_at desc);
create index if not exists calls_open_idx on public.calls (status) where status <> 'ended';

create table if not exists public.call_participants (
  call_id uuid not null references public.calls(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  state text not null default 'invited' check (state in ('invited','joined','left','declined','missed')),
  invited_at timestamptz not null default now(),
  joined_at timestamptz,
  left_at timestamptz,
  last_seen timestamptz not null default now(),
  primary key (call_id, user_id)
);
create index if not exists call_part_user_idx on public.call_participants (user_id, state);

-- 3) Helper (SECURITY DEFINER agar tidak rekursif lewat RLS)
create or replace function public.call_cfg() returns public.call_settings
language sql stable security definer set search_path = public as $$ select * from public.call_settings where id = 1 $$;

create or replace function public.call_can_signal(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.calls c join public.call_participants p on p.call_id = c.id
    where c.id = cid and c.status in ('ringing','active') and p.user_id = auth.uid() and p.state in ('invited','joined'))
$$;

-- Topik Realtime: 'call:<uuid>'. Regex dulu supaya cast uuid tidak melempar galat.
create or replace function public.call_topic_ok(topic text) returns boolean
language sql stable security definer set search_path = public as $$
  select topic ~ '^call:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and public.call_can_signal(substr(topic, 6)::uuid)
$$;

-- Menutup panggilan yang sudah tidak punya peserta/terlalu lama berdering. Dipanggil malas (lazy) oleh RPC.
create or replace function public.call_sweep() returns void
language plpgsql security definer set search_path = public as $$
declare cfg public.call_settings := public.call_cfg();
begin
  -- peserta joined yang heartbeat-nya basi dianggap keluar (tab ditutup/jaringan putus)
  update public.call_participants set state = 'left', left_at = now()
    where state = 'joined' and last_seen < now() - make_interval(secs => cfg.heartbeat_stale_secs);
  -- undangan yang kedaluwarsa menjadi tidak terjawab
  update public.call_participants p set state = 'missed'
    from public.calls c where c.id = p.call_id and p.state = 'invited'
      and c.created_at < now() - make_interval(secs => cfg.ring_timeout_secs) and c.status = 'ringing';
  -- panggilan berdering yang tak seorang pun menjawab
  update public.calls c set status = 'ended', ended_at = now(), end_reason = 'missed'
    where c.status = 'ringing' and c.created_at < now() - make_interval(secs => cfg.ring_timeout_secs + 5)
      and not exists (select 1 from public.call_participants p where p.call_id = c.id and p.state = 'joined' and p.user_id <> c.created_by);
  -- panggilan tanpa peserta joined sama sekali berakhir
  update public.calls c set status = 'ended', ended_at = now(), end_reason = coalesce(c.end_reason, 'empty')
    where c.status in ('ringing','active') and c.created_at < now() - interval '20 seconds'
      and not exists (select 1 from public.call_participants p where p.call_id = c.id and p.state = 'joined');
end $$;

-- Cek blok antara saya dan SEMUA peserta yang sedang joined (mesh = semua terhubung langsung).
create or replace function public.call_blocked_with_joined(cid uuid, uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.call_participants p
    where p.call_id = cid and p.user_id <> uid and p.state = 'joined' and public.is_blocked_between(uid, p.user_id))
$$;

-- 4) RPC: mulai panggilan
create or replace function public.call_start(conv uuid, k text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid(); cfg public.call_settings := public.call_cfg();
  cv public.conversations; cid uuid; other uuid; n int; online boolean; seen timestamptz; shown boolean;
begin
  if me is null then raise exception 'Sesi berakhir. Silakan masuk lagi.'; end if;
  if k not in ('voice','video') then raise exception 'Jenis panggilan tidak valid'; end if;
  if not exists (select 1 from public.profiles where id = me and not is_suspended) then raise exception 'Akun tidak dapat menelepon'; end if;
  perform public.call_sweep();
  select * into cv from public.conversations where id = conv;
  if cv.id is null or not public.is_member(conv) then raise exception 'Bukan anggota percakapan ini'; end if;
  -- satu panggilan aktif per pengguna
  if exists (select 1 from public.call_participants p join public.calls c on c.id = p.call_id
             where p.user_id = me and c.status in ('ringing','active') and p.state = 'joined') then
    raise exception 'BUSY_SELF: Kamu masih dalam panggilan lain';
  end if;
  -- batas laju
  select count(*) into n from public.calls where created_by = me and created_at > now() - interval '1 minute';
  if n >= cfg.max_starts_per_min then raise exception 'Terlalu sering menelepon. Tunggu sebentar.'; end if;
  -- panggilan grup yang masih berjalan di percakapan yang sama: gabung saja (tidak membuat sesi ganda)
  if cv.type = 'group' then
    select id into cid from public.calls where conversation_id = conv and status in ('ringing','active') order by created_at desc limit 1;
    if cid is not null then return jsonb_build_object('call_id', cid, 'existing', true); end if;
  end if;
  if cv.type = 'direct' then
    select user_id into other from public.conversation_members where conversation_id = conv and user_id <> me limit 1;
    if other is null then raise exception 'Lawan bicara tidak ditemukan'; end if;
    if public.is_blocked_between(me, other) then raise exception 'Tidak dapat menelepon pengguna ini'; end if;
    if not public.is_friend(me, other) then raise exception 'Telepon hanya bisa dengan teman'; end if;
    if exists (select 1 from public.call_participants p join public.calls c on c.id = p.call_id
               where p.user_id = other and c.status in ('ringing','active')
                 and (p.state = 'joined' or (p.state = 'invited' and c.created_at > now() - make_interval(secs => cfg.ring_timeout_secs + 5)))) then
      raise exception 'BUSY_OTHER: Sedang dalam panggilan lain';
    end if;
  end if;
  insert into public.calls (conversation_id, kind, scope, created_by) values (conv, k, cv.type, me) returning id into cid;
  insert into public.call_participants (call_id, user_id, state, joined_at) values (cid, me, 'joined', now());
  insert into public.call_participants (call_id, user_id, state)
    select cid, m.user_id, 'invited' from public.conversation_members m
    join public.profiles pr on pr.id = m.user_id and not pr.is_suspended
    where m.conversation_id = conv and m.user_id <> me and not public.is_blocked_between(me, m.user_id);
  if cv.type = 'direct' then
    select p.last_seen_at, p.show_last_seen into seen, shown from public.profiles p where p.id = other;
    online := case when shown then (seen is not null and seen > now() - interval '2 minutes') else null end;
  end if;
  return jsonb_build_object('call_id', cid, 'existing', false, 'likely_online', online);
end $$;

-- 5) RPC: gabung/terima. Mengembalikan peserta yang sudah joined (untuk menentukan siapa yang di-offer).
create or replace function public.call_join(cid uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid(); cfg public.call_settings := public.call_cfg(); c public.calls; mx int; n int; mine public.call_participants;
begin
  if me is null then raise exception 'Sesi berakhir. Silakan masuk lagi.'; end if;
  perform public.call_sweep();
  select * into c from public.calls where id = cid for update;
  if c.id is null or c.status = 'ended' then raise exception 'Panggilan sudah berakhir'; end if;
  if not public.is_member(c.conversation_id) then raise exception 'Bukan anggota percakapan ini'; end if;
  if not exists (select 1 from public.profiles where id = me and not is_suspended) then raise exception 'Akun tidak dapat menelepon'; end if;
  select * into mine from public.call_participants where call_id = cid and user_id = me;
  if mine.user_id is null then
    -- anggota grup yang tidak diundang saat mulai (bergabung belakangan / anggota baru)
    if c.scope <> 'group' or not cfg.allow_late_join then raise exception 'Kamu tidak diundang ke panggilan ini'; end if;
  elsif mine.state = 'declined' and c.scope = 'direct' then raise exception 'Panggilan sudah ditolak';
  end if;
  if public.call_blocked_with_joined(cid, me) then raise exception 'Tidak dapat bergabung ke panggilan ini'; end if;
  if c.scope = 'direct' and exists (select 1 from public.conversation_members m where m.conversation_id = c.conversation_id and m.user_id <> me
        and public.is_blocked_between(me, m.user_id)) then raise exception 'Tidak dapat bergabung ke panggilan ini'; end if;
  if exists (select 1 from public.call_participants p join public.calls c2 on c2.id = p.call_id
             where p.user_id = me and p.state = 'joined' and c2.status in ('ringing','active') and c2.id <> cid) then
    raise exception 'BUSY_SELF: Kamu masih dalam panggilan lain';
  end if;
  mx := case when c.scope = 'direct' then 2 when c.kind = 'video' then cfg.max_group_video else cfg.max_group_voice end;
  select count(*) into n from public.call_participants where call_id = cid and state = 'joined' and user_id <> me;
  if n + 1 > mx then raise exception 'FULL: Panggilan penuh (maks % peserta)', mx; end if;
  insert into public.call_participants (call_id, user_id, state, joined_at, last_seen, left_at)
    values (cid, me, 'joined', now(), now(), null)
    on conflict (call_id, user_id) do update set state = 'joined', joined_at = now(), last_seen = now(), left_at = null;
  if c.status = 'ringing' and me <> c.created_by then
    update public.calls set status = 'active', answered_at = now() where id = cid;
  end if;
  return jsonb_build_object('call_id', cid, 'kind', c.kind, 'scope', c.scope, 'conversation_id', c.conversation_id, 'max', mx,
    'joined', coalesce((select jsonb_agg(jsonb_build_object('user_id', p.user_id, 'joined_at', p.joined_at) order by p.joined_at)
                         from public.call_participants p where p.call_id = cid and p.state = 'joined' and p.user_id <> me), '[]'::jsonb));
end $$;

-- 6) RPC: tolak / batalkan / keluar / detak jantung
create or replace function public.call_decline(cid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); c public.calls;
begin
  select * into c from public.calls where id = cid for update;
  if c.id is null then return; end if;
  update public.call_participants set state = 'declined', left_at = now() where call_id = cid and user_id = me and state = 'invited';
  if c.scope = 'direct' and c.status = 'ringing' and me <> c.created_by then
    update public.calls set status = 'ended', ended_at = now(), end_reason = 'declined' where id = cid;
  end if;
end $$;

create or replace function public.call_leave(cid uuid, reason text default 'completed') returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); c public.calls; joined_n int;
        r text := case when reason in ('completed','cancelled','failed','timeout') then reason else 'completed' end;
begin
  select * into c from public.calls where id = cid for update;
  if c.id is null or c.status = 'ended' then return; end if;
  update public.call_participants set state = case when state = 'invited' then 'declined' else 'left' end, left_at = now()
    where call_id = cid and user_id = me and state in ('joined','invited');
  select count(*) into joined_n from public.call_participants where call_id = cid and state = 'joined';
  -- pribadi: selesai begitu salah satu keluar. Grup: selesai bila tak ada peserta joined tersisa.
  if c.scope = 'direct' or joined_n = 0 then
    update public.calls set status = 'ended', ended_at = now(),
      end_reason = case when c.status = 'ringing' and r = 'timeout' then 'missed'
                        when c.status = 'ringing' and r = 'completed' then 'cancelled'
                        else r end
      where id = cid;
    update public.call_participants set state = 'missed' where call_id = cid and state = 'invited';
    update public.call_participants set state = 'left', left_at = now() where call_id = cid and state = 'joined';
  end if;
end $$;

create or replace function public.call_heartbeat(cid uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.call_participants p set last_seen = now() from public.calls c
    where p.call_id = cid and p.user_id = auth.uid() and p.state = 'joined' and c.id = p.call_id and c.status in ('ringing','active');
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- 7) RPC: info untuk UI
create or replace function public.call_limits() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('max_group_voice', max_group_voice, 'max_group_video', max_group_video,
    'ring_timeout_secs', ring_timeout_secs, 'allow_late_join', allow_late_join) from public.call_settings where id = 1
$$;

-- Panggilan yang sedang berjalan/berdering di percakapan yang saya ikuti (untuk banner "Gabung" & undangan saat halaman dibuka)
create or replace function public.call_open_for_me() returns table (
  call_id uuid, conversation_id uuid, kind text, scope text, created_by uuid, status text, created_at timestamptz,
  my_state text, joined_count int)
language plpgsql security definer set search_path = public as $$
begin
  perform public.call_sweep();
  return query
  select c.id, c.conversation_id, c.kind, c.scope, c.created_by, c.status, c.created_at, p.state,
         (select count(*)::int from public.call_participants x where x.call_id = c.id and x.state = 'joined')
  from public.calls c
  join public.conversation_members m on m.conversation_id = c.conversation_id and m.user_id = auth.uid()
  left join public.call_participants p on p.call_id = c.id and p.user_id = auth.uid()
  where c.status in ('ringing','active')
    and not exists (select 1 from public.call_participants j where j.call_id = c.id and j.state = 'joined' and public.is_blocked_between(auth.uid(), j.user_id));
end $$;

-- Riwayat (masuk, keluar, tidak terjawab) untuk halaman /calls
create or replace function public.call_history(lim int default 50) returns table (
  call_id uuid, conversation_id uuid, kind text, scope text, created_by uuid, created_at timestamptz,
  answered_at timestamptz, ended_at timestamptz, end_reason text, my_state text, duration_secs int, title text, other_id uuid)
language sql stable security definer set search_path = public as $$
  select c.id, c.conversation_id, c.kind, c.scope, c.created_by, c.created_at, c.answered_at, c.ended_at, c.end_reason, p.state,
         case when c.answered_at is not null and c.ended_at is not null then greatest(0, extract(epoch from c.ended_at - c.answered_at)::int) end,
         cv.title,
         (select m.user_id from public.conversation_members m where m.conversation_id = c.conversation_id and m.user_id <> auth.uid() limit 1)
  from public.call_participants p
  join public.calls c on c.id = p.call_id
  join public.conversations cv on cv.id = c.conversation_id
  where p.user_id = auth.uid() and c.status = 'ended' and (select keep_history from public.call_settings where id = 1)
  order by c.created_at desc limit least(greatest(lim, 1), 100)
$$;

-- 8) RLS: tabel hanya bisa DIBACA peserta/anggota. Semua perubahan lewat RPC di atas (tidak ada policy insert/update/delete).
alter table public.call_settings enable row level security;
alter table public.calls enable row level security;
alter table public.call_participants enable row level security;

drop policy if exists calls_select on public.calls;
create policy calls_select on public.calls for select to authenticated
  using (public.is_member(conversation_id) and exists (select 1 from public.call_participants p where p.call_id = calls.id and p.user_id = auth.uid()));
drop policy if exists call_part_select on public.call_participants;
create policy call_part_select on public.call_participants for select to authenticated
  using (user_id = auth.uid() or public.call_can_signal(call_id));

revoke all on public.call_settings, public.calls, public.call_participants from anon, authenticated;
grant select on public.calls, public.call_participants to authenticated;

revoke all on function public.call_cfg(), public.call_sweep(), public.call_blocked_with_joined(uuid, uuid) from public, anon, authenticated;
revoke all on function public.call_can_signal(uuid), public.call_topic_ok(text) from public, anon;
grant execute on function public.call_can_signal(uuid), public.call_topic_ok(text) to authenticated;
revoke all on function public.call_start(uuid, text), public.call_join(uuid), public.call_decline(uuid), public.call_leave(uuid, text),
  public.call_heartbeat(uuid), public.call_limits(), public.call_open_for_me(), public.call_history(int) from public, anon;
grant execute on function public.call_start(uuid, text), public.call_join(uuid), public.call_decline(uuid), public.call_leave(uuid, text),
  public.call_heartbeat(uuid), public.call_limits(), public.call_open_for_me(), public.call_history(int) to authenticated;

-- 9) Otorisasi Realtime (private Broadcast). Hanya peserta sah panggilan yang aktif/berdering yang boleh
--    MENERIMA dan MENGIRIM di topik 'call:<id>'. Presence tidak dipakai. Topik lain tidak tersentuh policy ini.
do $$ begin
  if to_regclass('realtime.messages') is null then
    raise notice 'realtime.messages tidak ada: aktifkan Realtime Authorization (Project Settings, Realtime) lalu jalankan ulang bagian 9.';
  else
    execute 'drop policy if exists "orvix_call_receive" on realtime.messages';
    execute $p$create policy "orvix_call_receive" on realtime.messages for select to authenticated
      using (extension = 'broadcast' and public.call_topic_ok((select realtime.topic())))$p$;
    execute 'drop policy if exists "orvix_call_send" on realtime.messages';
    execute $p$create policy "orvix_call_send" on realtime.messages for insert to authenticated
      with check (extension = 'broadcast' and public.call_topic_ok((select realtime.topic())))$p$;
  end if;
exception when insufficient_privilege then
  raise notice 'Tidak punya izin membuat policy di realtime.messages lewat editor ini. Buat dua policy tersebut dari Dashboard (Realtime, Policies).';
end $$;

-- 10) Publikasi Realtime (undangan & perubahan status dikirim via postgres_changes, tersaring RLS)
do $$ begin
  begin alter publication supabase_realtime add table public.calls; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.call_participants; exception when duplicate_object then null; end;
end $$;
