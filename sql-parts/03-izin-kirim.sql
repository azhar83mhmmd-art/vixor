-- ORVIX fitur baru, BAGIAN 3/9: hanya pemilik yang boleh kirim di saluran + policy kirim pesan
create or replace function public.can_send(conv uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_member(conv)
    and exists (select 1 from public.profiles where id = auth.uid() and not is_suspended)
    and (not exists (select 1 from public.conversations c where c.id = conv and c.type = 'channel')
         or exists (select 1 from public.conversation_members m
                    where m.conversation_id = conv and m.user_id = auth.uid() and m.role = 'owner'))
    and not exists (
      select 1 from public.conversations c
      join public.conversation_members m on m.conversation_id = c.id and m.user_id <> auth.uid()
      where c.id = conv and c.type = 'direct' and public.is_blocked_between(auth.uid(), m.user_id))
$$;

drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and public.can_send(conversation_id)
    and (
      (message_type = 'text' and media_path is null and media_type is null
        and char_length(btrim(content)) between 1 and 4000)
      or
      (message_type in ('image','video') and media_type = message_type
        and char_length(content) <= 4000
        and media_path like conversation_id::text || '/' || auth.uid()::text || '/%')
    ));
