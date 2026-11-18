-- Show who is who in the Team screen: keep each person's login email on their profile.
-- Only the server (service key) writes it; the app can read it where RLS already allows reading the profile.
alter table public.profiles add column email text;

update public.profiles p set email = lower(u.email) from auth.users u where u.id = p.user_id and p.email is null;

create unique index profiles_email_key on public.profiles (lower(email)) where email is not null;

create or replace function public.bootstrap_owner(p_email text, p_full_name text) returns void
language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare uid uuid;
begin
  if exists (select 1 from public.profiles where is_owner) then raise exception 'An owner already exists'; end if;
  select id into uid from auth.users where lower(email) = lower(p_email);
  if uid is null then raise exception 'No login with that email. Create it first in Authentication > Users.'; end if;
  insert into public.profiles (user_id, full_name, email, is_owner) values (uid, p_full_name, lower(p_email), true);
end $$;
revoke all on function public.bootstrap_owner(text, text) from public, anon, authenticated;
