-- ORVIX fitur baru, BAGIAN 4/9: bucket chat-media (privat, 25 MB)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('chat-media', 'chat-media', false, 26214400,
   array['image/jpeg','image/png','image/webp','video/mp4','video/webm','video/quicktime'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types, public = false;

drop policy if exists chatmedia_select on storage.objects;
create policy chatmedia_select on storage.objects for select to authenticated
  using (bucket_id = 'chat-media' and public.is_member(((storage.foldername(name))[1])::uuid));

drop policy if exists chatmedia_insert on storage.objects;
create policy chatmedia_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'chat-media' and (storage.foldername(name))[2] = auth.uid()::text
              and public.can_send(((storage.foldername(name))[1])::uuid));

drop policy if exists chatmedia_delete on storage.objects;
create policy chatmedia_delete on storage.objects for delete to authenticated
  using (bucket_id = 'chat-media' and (storage.foldername(name))[2] = auth.uid()::text);
