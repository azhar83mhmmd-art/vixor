-- ORVIX BAGIAN 13b: hapus pesan hanya 1 jam, hapus/sematkan chat dari daftar. Aman dijalankan ulang.

-- Pelindung pesan: hapus-untuk-semua hanya dalam 1 jam. Edit: 15 menit (Premium: 1 jam). Pesan sistem tidak bisa diubah.
create or replace function public.messages_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare prem boolean;
begin
  if auth.uid() is null then return new; end if;   -- service role / SQL editor
  if old.message_type = 'system' then raise exception 'Pesan sistem tidak dapat diubah'; end if;
  if new.conversation_id <> old.conversation_id or new.sender_id <> old.sender_id
     or new.created_at <> old.created_at or new.message_type <> old.message_type then
    raise exception 'Kolom pesan ini tidak dapat diubah';
  end if;
  if old.deleted_at is not null then raise exception 'Pesan sudah dihapus'; end if;
  if new.deleted_at is not null then
    if now() - old.created_at > interval '1 hour' then raise exception 'Pesan hanya bisa dihapus dalam 1 jam setelah dikirim'; end if;
    new.deleted_at := now(); new.content := '';
  elsif new.content is distinct from old.content then
    select coalesce(premium_until > now(), false) into prem from public.profiles where id = old.sender_id;
    if now() - old.created_at > (case when prem then interval '1 hour' else interval '15 minutes' end) then
      raise exception 'Batas waktu edit pesan sudah lewat'; end if;
    if char_length(btrim(new.content)) < 1 then raise exception 'Pesan tidak boleh kosong'; end if;
    new.edited_at := now();
  end if;
  return new;
end $$;

-- Preferensi chat per pengguna: sematan (pin) dan "hapus chat" (kosongkan riwayat hanya untuk saya)
create table if not exists public.orvix_conv_prefs (
  user_id uuid not null references public.profiles(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  pinned_at timestamptz,
  cleared_at timestamptz,
  primary key (user_id, conversation_id)
);
alter table public.orvix_conv_prefs enable row level security;
drop policy if exists conv_prefs_select on public.orvix_conv_prefs;
create policy conv_prefs_select on public.orvix_conv_prefs for select to authenticated using (user_id = auth.uid());
revoke all on public.orvix_conv_prefs from anon, authenticated;
grant select on public.orvix_conv_prefs to authenticated;

create or replace function public.orvix_pin_conversations(convs uuid[], pin boolean) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); c uuid; lim int; cur int; prem boolean;
begin
  if me is null then raise exception 'Sesi berakhir. Silakan masuk lagi.'; end if;
  select coalesce(premium_until > now(), false) into prem from public.profiles where id = me;
  lim := case when prem then 10 else 3 end;
  foreach c in array coalesce(convs, '{}') loop
    if not exists (select 1 from public.conversation_members where conversation_id = c and user_id = me) then continue; end if;
    if pin then
      select count(*) into cur from public.orvix_conv_prefs where user_id = me and pinned_at is not null and conversation_id <> c;
      if cur >= lim then raise exception 'Maksimal % chat disematkan%', lim, case when prem then '.' else '. Premium bisa menyematkan hingga 10 chat.' end; end if;
      insert into public.orvix_conv_prefs (user_id, conversation_id, pinned_at) values (me, c, now())
        on conflict (user_id, conversation_id) do update set pinned_at = now();
    else
      update public.orvix_conv_prefs set pinned_at = null where user_id = me and conversation_id = c;
    end if;
  end loop;
end $$;

create or replace function public.orvix_clear_conversations(convs uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); c uuid;
begin
  if me is null then raise exception 'Sesi berakhir. Silakan masuk lagi.'; end if;
  foreach c in array coalesce(convs, '{}') loop
    if not exists (select 1 from public.conversation_members where conversation_id = c and user_id = me) then continue; end if;
    insert into public.orvix_conv_prefs (user_id, conversation_id, cleared_at, pinned_at) values (me, c, now(), null)
      on conflict (user_id, conversation_id) do update set cleared_at = now(), pinned_at = null;
  end loop;
end $$;

-- Daftar chat: sematan di atas, chat yang dihapus disembunyikan sampai ada pesan baru
drop function if exists public.list_my_conversations();
create function public.list_my_conversations()
returns table (conv_id uuid, conv_type text, title text, other_id uuid, other_username text, other_name text,
               other_avatar text, other_verified boolean, last_content text, last_at timestamptz,
               last_sender uuid, last_deleted boolean, unread bigint, created_at timestamptz,
               pinned boolean, cleared_at timestamptz)
language sql stable security definer set search_path = public as $$
  select conv_id, conv_type, title, other_id, other_username, other_name, other_avatar, other_verified, last_content, last_at,
         last_sender, last_deleted, unread, created_at, pinned, cleared_at
  from (
    select c.id, c.type, c.title, o.id, o.username, o.display_name, o.avatar_url, o.is_verified,
           lm.content, lm.created_at, lm.sender_id, (lm.deleted_at is not null),
           (select count(*) from public.messages m where m.conversation_id = c.id and m.sender_id <> auth.uid()
              and m.deleted_at is null and m.message_type <> 'system' and (m.expires_at is null or m.expires_at > now())
              and m.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)
              and m.created_at > coalesce(pf.cleared_at, '-infinity'::timestamptz)),
           c.created_at, (pf.pinned_at is not null), pf.cleared_at, pf.pinned_at as pin_at
    from public.conversations c
    join public.conversation_members me on me.conversation_id = c.id and me.user_id = auth.uid()
    left join public.message_reads r on r.conversation_id = c.id and r.user_id = auth.uid()
    left join public.orvix_conv_prefs pf on pf.conversation_id = c.id and pf.user_id = auth.uid()
    left join lateral (
      select p.id, p.username, p.display_name, p.avatar_url, p.is_verified
      from public.conversation_members cm join public.profiles p on p.id = cm.user_id
      where cm.conversation_id = c.id and cm.user_id <> auth.uid() and c.type = 'direct' limit 1) o on true
    left join lateral (
      select m.content, m.created_at, m.sender_id, m.deleted_at from public.messages m
      where m.conversation_id = c.id and m.message_type <> 'system' and (m.expires_at is null or m.expires_at > now())
        and m.created_at > coalesce(pf.cleared_at, '-infinity'::timestamptz)
      order by m.created_at desc limit 1) lm on true
    where pf.cleared_at is null or lm.created_at is not null
  ) x(conv_id, conv_type, title, other_id, other_username, other_name, other_avatar, other_verified, last_content, last_at,
      last_sender, last_deleted, unread, created_at, pinned, cleared_at, pin_at)
  order by (pin_at is not null) desc, pin_at desc nulls last, coalesce(last_at, created_at) desc
$$;

revoke all on function public.orvix_pin_conversations(uuid[], boolean), public.orvix_clear_conversations(uuid[]), public.list_my_conversations() from public, anon;
grant execute on function public.orvix_pin_conversations(uuid[], boolean), public.orvix_clear_conversations(uuid[]), public.list_my_conversations() to authenticated;
