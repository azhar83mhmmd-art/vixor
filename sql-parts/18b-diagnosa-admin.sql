-- ORVIX BAGIAN 18b: Diagnosa notifikasi khusus admin (push_diag menolak non-admin). Idempotent, tempel sekali.
drop function if exists public.push_diag();
create function public.push_diag() returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); res jsonb := '{}'::jsonb; has_net boolean; subs int; last jsonb := '[]'::jsonb; cfg_url text;
begin
  if me is null then raise exception 'Sesi berakhir. Silakan masuk lagi.'; end if;
  if not exists (select 1 from public.profiles where id = me and role = 'admin' and not is_suspended) then raise exception 'Khusus admin.'; end if;
  select value into cfg_url from public.push_config where key = 'url';
  has_net := exists (select 1 from pg_extension where extname = 'pg_net');
  select count(*) into subs from public.push_subscriptions where user_id = me;
  res := jsonb_build_object('has_url', cfg_url is not null, 'url_host', case when cfg_url is null then null else split_part(split_part(cfg_url, '//', 2), '/', 1) end,
    'has_secret', exists (select 1 from public.push_config where key = 'secret'), 'has_pg_net', has_net, 'my_subscriptions', subs,
    'trigger_message', exists (select 1 from pg_trigger where tgname = 'trg_push_message' and not tgisinternal));
  if has_net then
    begin
      execute $q$select coalesce(jsonb_agg(x), '[]'::jsonb) from (
          select status_code, left(coalesce(content, ''), 300) as body, left(coalesce(error_msg, ''), 200) as error, created
          from net._http_response order by created desc limit 4) x$q$ into last;
    exception when others then last := '[]'::jsonb; end;
  end if;
  return res || jsonb_build_object('responses', last);
end $$;

revoke all on function public.push_diag() from public, anon;
grant execute on function public.push_diag() to authenticated;
