-- ORVIX BAGIAN 11a: kolom foto saluran + fungsi pasang/hapus foto (khusus pemilik)
alter table public.conversations add column if not exists avatar_url text;

create or replace function public.orvix_set_channel_avatar(p_conv uuid, p_url text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.conversation_members m join public.conversations c on c.id = m.conversation_id
      where m.conversation_id = p_conv and m.user_id = auth.uid() and m.role = 'owner' and c.type = 'channel') then
    raise exception 'Hanya pemilik saluran yang bisa mengubah foto'; end if;
  if p_url is not null and (char_length(p_url) > 500
      or p_url not like ('%/storage/v1/object/public/avatars/' || auth.uid()::text || '/%')) then
    raise exception 'Alamat foto tidak valid'; end if;
  update public.conversations set avatar_url = p_url where id = p_conv;
end $$;

revoke execute on function public.orvix_set_channel_avatar(uuid, text) from public, anon;
grant execute on function public.orvix_set_channel_avatar(uuid, text) to authenticated;
