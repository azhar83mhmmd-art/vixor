-- ORVIX fitur baru, BAGIAN 1/9: bersihkan fungsi lama + kolom media pesan
do $$ declare r record; begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('create_channel','follow_channel','unfollow_channel','list_my_channels',
      'discover_channels','get_invite_code','invite_preview','join_by_invite','seed_official_channels','new_invite_code','set_invite_code')
  loop execute 'drop function if exists ' || r.sig || ' cascade'; end loop;
end $$;

alter table public.messages add column if not exists media_path text;
alter table public.messages add column if not exists media_type text;
alter table public.messages drop constraint if exists messages_media_type_check;
alter table public.messages add constraint messages_media_type_check check (media_type is null or media_type in ('image','video'));
alter table public.messages drop constraint if exists messages_message_type_check;
alter table public.messages add constraint messages_message_type_check check (message_type in ('text','image','video'));
grant insert (conversation_id, sender_id, content, message_type, media_path, media_type) on public.messages to authenticated;
