-- ORVIX fitur baru, BAGIAN 2/9: kolom grup & saluran + kode undangan
alter table public.conversations drop constraint if exists conversations_type_check;
alter table public.conversations add constraint conversations_type_check check (type in ('direct','group','channel'));
alter table public.conversations drop constraint if exists conversations_check;
alter table public.conversations drop constraint if exists conversations_kind_check;
alter table public.conversations add constraint conversations_kind_check
  check ((type = 'direct' and direct_key is not null) or (type <> 'direct' and direct_key is null));
alter table public.conversations add column if not exists description text;
alter table public.conversations drop constraint if exists conversations_description_check;
alter table public.conversations add constraint conversations_description_check check (description is null or char_length(description) <= 300);
alter table public.conversations add column if not exists is_public boolean not null default false;
alter table public.conversations add column if not exists is_official boolean not null default false;
alter table public.conversations add column if not exists invite_code text;
alter table public.conversations add column if not exists slug text;
create unique index if not exists conversations_invite_code_uq on public.conversations (invite_code);
create unique index if not exists conversations_slug_uq on public.conversations (slug);

create or replace function public.new_invite_code() returns text
language sql volatile set search_path = public as $$
  select substr(replace(gen_random_uuid()::text, '-', ''), 1, 16) $$;

create or replace function public.set_invite_code() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.type <> 'direct' and new.invite_code is null then new.invite_code := public.new_invite_code(); end if;
  return new;
end $$;

drop trigger if exists trg_conv_invite on public.conversations;
create trigger trg_conv_invite before insert on public.conversations
  for each row execute function public.set_invite_code();

update public.conversations set invite_code = public.new_invite_code()
  where invite_code is null and type <> 'direct';
