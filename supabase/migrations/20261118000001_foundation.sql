-- StoreVision foundation: branches, people, roles per branch, audit trail.
-- Design rules:
--   * Every business table (added in later migrations) carries branch_id, so Jhajjar / Jharli are just more rows.
--   * Roles are PER BRANCH (admin / manager / counter). An "owner" is a global admin who can create branches
--     and promote admins. Everything is enforced by Row Level Security, not by the app UI.
--   * Nothing is physically deleted by the app: people are deactivated; every change is written to audit_log.
--   * All grants are explicit, so this is safe whether or not Supabase auto-grants new tables to the API.

create type public.app_role as enum ('admin', 'manager', 'counter');

create table public.branches (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,                      -- SAP "Branch Code", e.g. 6696 (checked against uploaded SAP files)
  name       text not null,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.profiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  full_name  text not null check (length(btrim(full_name)) > 0),
  is_owner   boolean not null default false,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.memberships (
  user_id    uuid not null references public.profiles (user_id) on delete cascade,
  branch_id  uuid not null references public.branches (id) on delete cascade,
  role       public.app_role not null,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  primary key (user_id, branch_id)
);
create index memberships_branch_idx on public.memberships (branch_id);

create table public.audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor      uuid,                                       -- null = done from the SQL editor / service key
  branch_id  uuid,
  table_name text not null,
  row_key    text,
  action     text not null,
  old_data   jsonb,
  new_data   jsonb
);
create index audit_log_branch_at_idx on public.audit_log (branch_id, at desc);

alter table public.branches    enable row level security;
alter table public.profiles    enable row level security;
alter table public.memberships enable row level security;
alter table public.audit_log   enable row level security;

-- ---------------------------------------------------------------- helper functions (run with definer rights so policies never recurse)
create function public.is_owner() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select p.is_owner and p.active from public.profiles p where p.user_id = (select auth.uid())), false)
$$;

create function public.branch_role(b uuid) returns public.app_role
language sql stable security definer set search_path = public, pg_temp as $$
  select m.role from public.memberships m join public.profiles p on p.user_id = m.user_id
  where m.user_id = (select auth.uid()) and m.branch_id = b and m.active and p.active
$$;

-- true if the caller holds one of the roles in that branch (an owner counts as admin everywhere)
create function public.has_branch_role(b uuid, roles public.app_role[]) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select (public.is_owner() and 'admin'::public.app_role = any (roles)) or coalesce(public.branch_role(b) = any (roles), false)
$$;

-- managers/admins may see the people who work in a branch they staff
create function public.is_staff_of_person(target uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.memberships mt
    join public.memberships me on me.branch_id = mt.branch_id
    join public.profiles pme on pme.user_id = me.user_id
    where mt.user_id = target and me.user_id = (select auth.uid())
      and me.active and pme.active and me.role in ('admin', 'manager')
  )
$$;

-- ---------------------------------------------------------------- policies
create policy branches_select on public.branches for select to authenticated
  using (public.is_owner() or public.branch_role(id) is not null);
create policy branches_insert on public.branches for insert to authenticated with check (public.is_owner());
create policy branches_update on public.branches for update to authenticated using (public.is_owner()) with check (public.is_owner());

create policy profiles_select on public.profiles for select to authenticated
  using (user_id = (select auth.uid()) or public.is_owner() or public.is_staff_of_person(user_id));
create policy profiles_update on public.profiles for update to authenticated using (public.is_owner()) with check (public.is_owner());

create policy memberships_select on public.memberships for select to authenticated
  using (user_id = (select auth.uid()) or public.is_owner() or public.has_branch_role(branch_id, array['admin', 'manager']::public.app_role[]));
-- A branch admin may add/deactivate managers and counters in THEIR branch. Only an owner can create or change admins.
create policy memberships_insert on public.memberships for insert to authenticated
  with check (public.is_owner() or (public.has_branch_role(branch_id, array['admin']::public.app_role[]) and role in ('manager', 'counter')));
create policy memberships_update on public.memberships for update to authenticated
  using (public.is_owner() or (public.has_branch_role(branch_id, array['admin']::public.app_role[]) and role in ('manager', 'counter')))
  with check (public.is_owner() or (public.has_branch_role(branch_id, array['admin']::public.app_role[]) and role in ('manager', 'counter')));

create policy audit_select on public.audit_log for select to authenticated
  using (public.is_owner() or (branch_id is not null and public.has_branch_role(branch_id, array['admin']::public.app_role[])));

-- ---------------------------------------------------------------- audit + safety triggers
create function public.log_audit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare r jsonb; b uuid; k text;
begin
  if tg_op = 'DELETE' then r := to_jsonb(old); else r := to_jsonb(new); end if;
  b := case tg_table_name when 'branches' then (r ->> 'id')::uuid when 'memberships' then (r ->> 'branch_id')::uuid else null end;
  k := case tg_table_name when 'branches' then r ->> 'id' else r ->> 'user_id' end;
  insert into public.audit_log (actor, branch_id, table_name, row_key, action, old_data, new_data)
  values ((select auth.uid()), b, tg_table_name, k, tg_op,
          case when tg_op <> 'INSERT' then to_jsonb(old) end, case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return case when tg_op = 'DELETE' then old else new end;
end $$;

create trigger audit_branches    after insert or update or delete on public.branches    for each row execute function public.log_audit();
create trigger audit_profiles    after insert or update or delete on public.profiles    for each row execute function public.log_audit();
create trigger audit_memberships after insert or update or delete on public.memberships for each row execute function public.log_audit();

-- never lock everyone out: the last active owner cannot be demoted, deactivated or deleted
create function public.protect_last_owner() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.is_owner and old.active and (tg_op = 'DELETE' or not new.is_owner or not new.active) then
    if not exists (select 1 from public.profiles p where p.is_owner and p.active and p.user_id <> old.user_id) then
      raise exception 'Cannot remove the last active owner' using errcode = 'P0001';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger protect_last_owner before update or delete on public.profiles for each row execute function public.protect_last_owner();

-- ---------------------------------------------------------------- one-time bootstrap (SQL editor only)
create function public.bootstrap_owner(p_email text, p_full_name text) returns void
language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare uid uuid;
begin
  if exists (select 1 from public.profiles where is_owner) then raise exception 'An owner already exists'; end if;
  select id into uid from auth.users where lower(email) = lower(p_email);
  if uid is null then raise exception 'No login with that email. Create it first in Authentication > Users.'; end if;
  insert into public.profiles (user_id, full_name, is_owner) values (uid, p_full_name, true);
end $$;

-- ---------------------------------------------------------------- explicit grants (least privilege)
revoke all on public.branches, public.profiles, public.memberships, public.audit_log from anon, authenticated;
revoke all on function public.bootstrap_owner(text, text), public.log_audit(), public.protect_last_owner() from public, anon, authenticated;
revoke all on function public.is_owner(), public.branch_role(uuid), public.has_branch_role(uuid, public.app_role[]), public.is_staff_of_person(uuid) from public, anon;

grant usage on type public.app_role to authenticated;
grant execute on function public.is_owner(), public.branch_role(uuid), public.has_branch_role(uuid, public.app_role[]), public.is_staff_of_person(uuid) to authenticated;
grant select on public.branches, public.profiles, public.memberships, public.audit_log to authenticated;
grant insert, update (name, active) on public.branches to authenticated;           -- the SAP branch code is immutable
grant update (full_name, is_owner, active) on public.profiles to authenticated;    -- rows are created by the server (service key), never by the app
grant insert (user_id, branch_id, role, active, created_by), update (role, active) on public.memberships to authenticated;
