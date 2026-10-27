-- ORVIX fitur baru, BAGIAN 9/9: izin eksekusi + isi saluran resmi
revoke execute on function public.new_invite_code(), public.set_invite_code() from public, anon, authenticated;

revoke execute on function public.create_channel(text, text, boolean), public.follow_channel(uuid),
  public.unfollow_channel(uuid), public.list_my_channels(), public.discover_channels(int),
  public.get_invite_code(uuid), public.join_by_invite(text), public.seed_official_channels()
  from public, anon;
grant execute on function public.create_channel(text, text, boolean), public.follow_channel(uuid),
  public.unfollow_channel(uuid), public.list_my_channels(), public.discover_channels(int),
  public.get_invite_code(uuid), public.join_by_invite(text), public.seed_official_channels()
  to authenticated;

grant execute on function public.invite_preview(text) to anon, authenticated;

do $$ begin
  if exists (select 1 from public.profiles where role = 'admin') then perform public.seed_official_channels(); end if;
end $$;
