-- ORVIX BAGIAN 9/9: saluran rekomendasi HANYA dari pengguna + real-time
-- Aman dijalankan di database baru maupun yang sudah menjalankan bagian lama.

-- 1) Hapus 12 saluran resmi bawaan dan fungsi pengisinya
delete from public.conversations where type = 'channel' and is_official = true;
drop function if exists public.seed_official_channels() cascade;

-- 2) Saluran publik boleh dilihat semua pengguna login (agar muncul real-time)
drop policy if exists conv_select_public on public.conversations;
create policy conv_select_public on public.conversations for select to authenticated
  using (type = 'channel' and is_public);

do $$ begin
  alter publication supabase_realtime add table public.conversations;
exception when duplicate_object then null; end $$;

-- 3) Rekomendasi: saluran publik buatan pengguna, pengikut terbanyak lalu terbaru
drop function if exists public.discover_channels(int);
create function public.discover_channels(lim int default 20)
returns table (conv_id uuid, title text, description text, is_official boolean,
               followers bigint, following boolean, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select t.id, t.title, t.description, t.is_official, t.f,
    exists (select 1 from public.conversation_members x where x.conversation_id = t.id and x.user_id = auth.uid()),
    t.created_at
  from (
    select c.id, c.title, c.description, c.is_official, c.created_at,
      (select count(*) from public.conversation_members x where x.conversation_id = c.id) as f
    from public.conversations c where c.type = 'channel' and c.is_public
  ) t
  order by t.f desc, t.created_at desc
  limit least(greatest(lim, 1), 50)
$$;
revoke execute on function public.discover_channels(int) from public, anon;
grant execute on function public.discover_channels(int) to authenticated;
