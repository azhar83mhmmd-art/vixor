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
