-- ORVIX BAGIAN 18a: perbaikan rantai push (pg_net + pemicu). Kecil & idempotent, aman dijalankan ulang.
-- Jalankan SESUDAH 15a dan 17a. Cukup tempel seluruh file ini sekali.

-- 1) Aktifkan pg_net (di Supabase berada di schema "extensions").
create extension if not exists pg_net with schema extensions;

-- 2) Fungsi pemicu (dipasang ulang agar pasti ada).
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

-- 3) Pemicu.
drop trigger if exists trg_push_message on public.messages;
create trigger trg_push_message after insert on public.messages for each row execute function public.push_trg_message();
drop trigger if exists trg_push_friend on public.friendships;
create trigger trg_push_friend after insert on public.friendships for each row execute function public.push_trg_friend();

-- 4) Pemicu panggilan. Fungsi dibuat biasa (isi baru dievaluasi saat dipanggil); pemicunya dipasang hanya bila tabelnya ada.
create or replace function public.push_trg_call() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.state = 'invited' then perform public.push_post(jsonb_build_object('type', 'call', 'call_id', new.call_id, 'user_id', new.user_id)); end if;
  return null;
exception when others then return null;
end $$;

do $$ begin
  if to_regclass('public.call_participants') is not null then
    drop trigger if exists trg_push_call on public.call_participants;
    create trigger trg_push_call after insert on public.call_participants for each row execute function public.push_trg_call();
  end if;
end $$;

revoke all on function public.push_trg_message(), public.push_trg_friend() from public, anon, authenticated;

-- 5) Hasil: harus menampilkan pg_net = true dan 2 pemicu (3 bila panggilan aktif).
select (select exists (select 1 from pg_extension where extname = 'pg_net')) as pg_net,
       (select count(*) from pg_trigger where tgname like 'trg_push_%' and not tgisinternal) as jumlah_pemicu;
