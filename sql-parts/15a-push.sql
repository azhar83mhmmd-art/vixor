-- ORVIX BAGIAN 15a: Web Push (langganan, preferensi, pemicu ke Edge Function push-send).
-- Idempotent, tidak mengubah tabel/data lama. Tidak butuh 14a (pemicu panggilan dipasang hanya bila tabel call_participants ada).
-- Alur: INSERT pesan/permintaan teman/undangan panggilan -> trigger -> pg_net -> Edge Function push-send (service role) -> push service -> sw.js.
-- Trigger TIDAK PERNAH menggagalkan pengiriman pesan: semua galat ditelan.

-- 1) Tabel. Seluruhnya tertutup untuk klien: akses hanya lewat RPC di bawah (dan service role di Edge Function).
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique check (char_length(endpoint) between 20 and 2048 and endpoint ~ '^https://'),
  p256dh text not null check (char_length(p256dh) between 20 and 200),
  auth text not null check (char_length(auth) between 8 and 100),
  user_agent text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  failures int not null default 0
);
create index if not exists push_subs_user_idx on public.push_subscriptions (user_id);

create table if not exists public.push_prefs (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  prefs jsonb not null default '{}'::jsonb,
  last_test_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.push_config (key text primary key, value text not null);   -- url + secret webhook (hanya terbaca oleh fungsi definer)

alter table public.push_subscriptions enable row level security;
alter table public.push_prefs enable row level security;
alter table public.push_config enable row level security;
revoke all on public.push_subscriptions, public.push_prefs, public.push_config from anon, authenticated;
-- sengaja tanpa policy: endpoint & kunci enkripsi tidak pernah bisa dibaca klien, termasuk pemiliknya.

-- 2) RPC untuk klien
create or replace function public.push_subscribe(p_ep text, p_key text, p_auth text, p_ua text default null) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'Sesi berakhir. Silakan masuk lagi.'; end if;
  -- endpoint dimiliki satu akun: bila perangkat berganti akun, langganan berpindah ke akun yang sedang login
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, last_ok_at)
    values (me, p_ep, p_key, p_auth, left(p_ua, 200), now())
    on conflict (endpoint) do update set user_id = me, p256dh = excluded.p256dh, auth = excluded.auth,
      user_agent = excluded.user_agent, last_ok_at = now(), failures = 0;
  -- batasi 10 perangkat per akun (yang terlama dibuang)
  delete from public.push_subscriptions where id in (
    select id from public.push_subscriptions where user_id = me order by created_at desc offset 10);
end $$;

create or replace function public.push_unsubscribe(ep text) returns void
language sql security definer set search_path = public as $$
  delete from public.push_subscriptions where endpoint = ep and user_id = auth.uid()
$$;

create or replace function public.push_has(ep text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.push_subscriptions where endpoint = ep and user_id = auth.uid())
$$;

create or replace function public.push_get_prefs() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select prefs from public.push_prefs where user_id = auth.uid()), '{}'::jsonb)
$$;

create or replace function public.push_set_prefs(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); clean jsonb := '{}'::jsonb; k text;
begin
  if me is null then raise exception 'Sesi berakhir. Silakan masuk lagi.'; end if;
  foreach k in array array['messages','groups','friends','calls','preview'] loop
    if p ? k and jsonb_typeof(p -> k) = 'boolean' then clean := clean || jsonb_build_object(k, p -> k); end if;
  end loop;
  insert into public.push_prefs (user_id, prefs) values (me, clean)
    on conflict (user_id) do update set prefs = public.push_prefs.prefs || excluded.prefs, updated_at = now();
end $$;

-- 3) Pengirim internal ke Edge Function (tidak bisa dipanggil klien)
create or replace function public.push_post(payload jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare u text; s text;
begin
  select value into u from public.push_config where key = 'url';
  select value into s from public.push_config where key = 'secret';
  if u is null or s is null then return; end if;                -- belum dikonfigurasi: tidak melakukan apa pun
  perform net.http_post(url := u, body := payload, headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', s), timeout_milliseconds := 3000);
exception when others then null;                                -- pg_net belum aktif / jaringan: jangan ganggu transaksi asal
end $$;

create or replace function public.push_test() returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); last timestamptz;
begin
  if me is null then raise exception 'Sesi berakhir. Silakan masuk lagi.'; end if;
  if not exists (select 1 from public.push_config where key = 'url') then raise exception 'Server push belum dikonfigurasi (push_configure belum dijalankan).'; end if;
  select last_test_at into last from public.push_prefs where user_id = me;
  if last is not null and last > now() - interval '30 seconds' then raise exception 'Tunggu sebentar sebelum mengirim uji lagi.'; end if;
  insert into public.push_prefs (user_id, last_test_at) values (me, now()) on conflict (user_id) do update set last_test_at = now();
  perform public.push_post(jsonb_build_object('type', 'test', 'user_id', me));
end $$;

-- Dijalankan SEKALI oleh pemilik project di SQL Editor:  select public.push_configure('https://<ref>.supabase.co/functions/v1/push-send', '<PUSH_WEBHOOK_SECRET>');
create or replace function public.push_configure(fn_url text, secret text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if fn_url !~ '^https://' or char_length(secret) < 24 then raise exception 'URL harus https dan secret minimal 24 karakter'; end if;
  insert into public.push_config (key, value) values ('url', fn_url), ('secret', secret)
    on conflict (key) do update set value = excluded.value;
end $$;

-- 4) Pemicu. Hanya mengirim id; Edge Function membaca data sendiri dengan service role dan menentukan penerima.
create or replace function public.push_trg_message() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.deleted_at is null and coalesce(new.message_type, 'text') <> 'system' then
    perform public.push_post(jsonb_build_object('type', 'message', 'id', new.id));
  end if;
  return null;
exception when others then return null;
end $$;

create or replace function public.push_trg_friend() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'pending' then perform public.push_post(jsonb_build_object('type', 'friend', 'id', new.id)); end if;
  return null;
exception when others then return null;
end $$;

drop trigger if exists trg_push_message on public.messages;
create trigger trg_push_message after insert on public.messages for each row execute function public.push_trg_message();
drop trigger if exists trg_push_friend on public.friendships;
create trigger trg_push_friend after insert on public.friendships for each row execute function public.push_trg_friend();

do $$ begin
  if to_regclass('public.call_participants') is not null then
    execute $f$create or replace function public.push_trg_call() returns trigger
      language plpgsql security definer set search_path = public as $b$
      begin
        if new.state = 'invited' then perform public.push_post(jsonb_build_object('type', 'call', 'call_id', new.call_id, 'user_id', new.user_id)); end if;
        return null;
      exception when others then return null;
      end $b$$f$;
    execute 'drop trigger if exists trg_push_call on public.call_participants';
    execute 'create trigger trg_push_call after insert on public.call_participants for each row execute function public.push_trg_call()';
  end if;
end $$;

-- 5) pg_net (untuk memanggil Edge Function dari trigger). Bila gagal, aktifkan manual: Database, Extensions, pg_net.
do $$ begin
  begin create extension if not exists pg_net; exception when others then raise notice 'Aktifkan ekstensi pg_net dari Dashboard (Database, Extensions).'; end;
end $$;

-- 6) Izin eksekusi
revoke all on function public.push_post(jsonb), public.push_configure(text, text), public.push_trg_message(), public.push_trg_friend() from public, anon, authenticated;
revoke all on function public.push_subscribe(text, text, text, text), public.push_unsubscribe(text), public.push_has(text),
  public.push_get_prefs(), public.push_set_prefs(jsonb), public.push_test() from public, anon;
grant execute on function public.push_subscribe(text, text, text, text), public.push_unsubscribe(text), public.push_has(text),
  public.push_get_prefs(), public.push_set_prefs(jsonb), public.push_test() to authenticated;
