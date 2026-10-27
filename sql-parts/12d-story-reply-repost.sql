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
