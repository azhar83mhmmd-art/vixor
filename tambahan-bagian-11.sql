-- ---------- 11. TANPA KONFIRMASI EMAIL ----------
create or replace function public.auto_confirm_user() returns trigger language plpgsql security definer set search_path = public as $$ begin new.email_confirmed_at := coalesce(new.email_confirmed_at, now()); return new; end $$;
drop trigger if exists trg_auto_confirm on auth.users;
create trigger trg_auto_confirm before insert on auth.users for each row execute function public.auto_confirm_user();
revoke execute on function public.auto_confirm_user() from public, anon, authenticated;
update auth.users set email_confirmed_at = now() where email_confirmed_at is null;
