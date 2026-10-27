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
