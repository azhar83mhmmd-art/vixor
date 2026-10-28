-- ORVIX BAGIAN 18c: centang 2 abu-abu saat perangkat penerima menerima push (walau aplikasi tertutup). Idempotent.
-- Dipanggil service worker penerima dengan endpoint langganannya (rahasia perangkat). Hanya menandai "diterima", tidak pernah "dibaca".
create or replace function public.push_ack(ep text, conv uuid) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  select user_id into uid from public.push_subscriptions where endpoint = ep;
  if uid is null then return; end if;
  if not exists (select 1 from public.conversation_members where conversation_id = conv and user_id = uid) then return; end if;
  insert into public.message_reads (conversation_id, user_id, last_read_at, last_delivered_at)
    values (conv, uid, '-infinity'::timestamptz, now())
    on conflict (conversation_id, user_id) do update set last_delivered_at = now();
exception when others then return;
end $$;

revoke all on function public.push_ack(text, uuid) from public;
grant execute on function public.push_ack(text, uuid) to anon, authenticated;
