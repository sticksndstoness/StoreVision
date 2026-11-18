-- Permission tests for the foundation migration. Each check raises an exception on failure (psql then stops with an error).
\set VERBOSITY terse
create schema t;
grant usage on schema t to public;   -- helpers are called while impersonating anon/authenticated

create function t.pass(msg text) returns void language plpgsql as $$ begin raise notice 'PASS - %', msg; end $$;
create function t.check(cond boolean, msg text) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'FAIL - %', msg; end if; perform t.pass(msg); end $$;

create function t.as_user(u uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', u::text, true); execute 'set local role authenticated'; end $$;
create function t.as_anon() returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', '', true); execute 'set local role anon'; end $$;
create function t.back() returns void language plpgsql as $$
begin execute 'reset role'; perform set_config('request.jwt.claim.sub', '', true); end $$;

-- number of rows a query returns when run as that user
create function t.count_as(u uuid, q text) returns bigint language plpgsql as $$
declare n bigint;
begin perform t.as_user(u); execute 'select count(*) from (' || q || ') s' into n; perform t.back(); return n; end $$;

-- statement must be refused (permission denied / RLS violation)
create function t.denied(u uuid, stmt text, msg text) returns void language plpgsql as $$
begin
  perform t.as_user(u);
  begin execute stmt; perform t.back(); raise exception 'FAIL - % (statement was allowed)', msg;
  exception when insufficient_privilege then perform t.back(); perform t.pass(msg);
  end;
end $$;

-- statement must run but change nothing (RLS hides the rows)
create function t.no_effect(u uuid, stmt text, msg text) returns void language plpgsql as $$
declare n bigint;
begin
  perform t.as_user(u); execute stmt; get diagnostics n = row_count; perform t.back();
  if n <> 0 then raise exception 'FAIL - % (changed % rows)', msg, n; end if; perform t.pass(msg);
end $$;

-- statement must succeed and change exactly n rows
create function t.allowed(u uuid, stmt text, n_expected bigint, msg text) returns void language plpgsql as $$
declare n bigint;
begin
  perform t.as_user(u); execute stmt; get diagnostics n = row_count; perform t.back();
  if n <> n_expected then raise exception 'FAIL - % (expected % rows, got %)', msg, n_expected, n; end if; perform t.pass(msg);
end $$;

-- ------------------------------------------------------------------ fixtures
-- O = owner, A = Bilaspur admin, M = Bilaspur manager, C1/C2 = Bilaspur counters, J = Jhajjar admin,
-- Z = person with no branch, X = deactivated person who still has an old membership
\set O '00000000-0000-0000-0000-0000000000a1'
\set A '00000000-0000-0000-0000-0000000000a2'
\set M '00000000-0000-0000-0000-0000000000a3'
\set C1 '00000000-0000-0000-0000-0000000000a4'
\set C2 '00000000-0000-0000-0000-0000000000a5'
\set J '00000000-0000-0000-0000-0000000000a6'
\set Z '00000000-0000-0000-0000-0000000000a7'
\set X '00000000-0000-0000-0000-0000000000a8'
\set O2 '00000000-0000-0000-0000-0000000000a9'
\set JHA '10000000-0000-0000-0000-000000000002'

insert into auth.users (id, email) select u, 'u' || right(u::text, 2) || '@example.test'
  from unnest(array[:'O', :'A', :'M', :'C1', :'C2', :'J', :'Z', :'X', :'O2']::uuid[]) u;
select public.bootstrap_owner('ua1@example.test', 'Owner One');
insert into public.profiles (user_id, full_name, active) values
  (:'A', 'Admin Bil', true), (:'M', 'Manager Bil', true), (:'C1', 'Counter 1', true), (:'C2', 'Counter 2', true),
  (:'J', 'Admin Jha', true), (:'Z', 'No Branch', true), (:'X', 'Left Company', false);
-- Bilaspur comes from the seed migration; look its id up instead of inserting it
select id as "BIL" from public.branches where code = '6696' \gset
insert into public.branches (id, code, name) values (:'JHA', '7001', 'Jhajjar');
insert into public.memberships (user_id, branch_id, role) values
  (:'A', :'BIL', 'admin'), (:'M', :'BIL', 'manager'), (:'C1', :'BIL', 'counter'), (:'C2', :'BIL', 'counter'),
  (:'J', :'JHA', 'admin'), (:'X', :'BIL', 'counter');
select t.check((select count(*) from public.audit_log where table_name = 'memberships') = 6, 'setup done; audit trail recorded the 6 memberships even from the SQL editor');
select t.check((select count(*) from public.audit_log where actor is null) > 0, 'changes made without a logged-in user are recorded with no actor');

-- ------------------------------------------------------------------ anonymous visitors (anyone holding the public key)
do $$ begin
  perform t.as_anon();
  begin perform count(*) from public.branches; raise exception 'FAIL - anon could read branches';
  exception when insufficient_privilege then perform t.back(); perform t.pass('anon cannot read branches (no privilege at all)'); end;
  perform t.as_anon();
  begin perform count(*) from public.profiles; raise exception 'FAIL - anon could read profiles';
  exception when insufficient_privilege then perform t.back(); perform t.pass('anon cannot read profiles'); end;
  perform t.as_anon();
  begin perform public.bootstrap_owner('x@y.z', 'Hacker'); raise exception 'FAIL - anon could call bootstrap_owner';
  exception when insufficient_privilege then perform t.back(); perform t.pass('anon cannot call bootstrap_owner'); end;
end $$;

-- ------------------------------------------------------------------ counter (helper)
select t.check(t.count_as(:'C1', 'select 1 from public.profiles') = 1, 'counter sees only their own profile, not colleagues');
select t.check(t.count_as(:'C1', 'select 1 from public.memberships') = 1, 'counter sees only their own membership');
select t.check(t.count_as(:'C1', 'select 1 from public.branches') = 1, 'counter sees only their own branch');
select t.check(t.count_as(:'C1', 'select 1 from public.audit_log') = 0, 'counter cannot read the audit log');
select t.denied(:'C1', format($q$insert into public.memberships (user_id, branch_id, role) values (%L, %L, 'counter')$q$, :'Z', :'BIL'), 'counter cannot add people');
select t.no_effect(:'C1', format($q$update public.memberships set role = 'admin' where user_id = %L$q$, :'C1'), 'counter cannot promote themselves');
select t.no_effect(:'C1', format($q$update public.profiles set is_owner = true where user_id = %L$q$, :'C1'), 'counter cannot make themselves owner');
select t.denied(:'C1', format($q$insert into public.branches (code, name) values ('1', 'Mine')$q$), 'counter cannot create a branch');

-- ------------------------------------------------------------------ manager
select t.check(t.count_as(:'M', 'select 1 from public.profiles') = 5, 'manager sees the people of their branch (4 colleagues + self), nobody else');
select t.check(t.count_as(:'M', 'select 1 from public.memberships') = 5, 'manager sees the branch team (incl. deactivated)');
select t.check(t.count_as(:'M', 'select 1 from public.audit_log') = 0, 'manager cannot read the audit log');
select t.denied(:'M', format($q$insert into public.memberships (user_id, branch_id, role) values (%L, %L, 'counter')$q$, :'Z', :'BIL'), 'manager cannot add people (admin job)');
select t.no_effect(:'M', format($q$update public.memberships set active = false where user_id = %L$q$, :'C1'), 'manager cannot deactivate people');

-- ------------------------------------------------------------------ cross-branch isolation
select t.check(t.count_as(:'J', 'select 1 from public.branches') = 1, 'Jhajjar admin sees only Jhajjar');
select t.check(t.count_as(:'J', format($q$select 1 from public.memberships where branch_id = %L$q$, :'BIL')) = 0, 'Jhajjar admin cannot see Bilaspur people');
select t.check(t.count_as(:'A', format($q$select 1 from public.memberships where branch_id = %L$q$, :'JHA')) = 0, 'Bilaspur admin cannot see Jhajjar people');
select t.denied(:'A', format($q$insert into public.memberships (user_id, branch_id, role) values (%L, %L, 'counter')$q$, :'Z', :'JHA'), 'Bilaspur admin cannot add people to Jhajjar');

-- ------------------------------------------------------------------ branch admin
select t.check(t.count_as(:'A', 'select 1 from public.branches') = 1, 'branch admin sees only their branch');
select t.check(t.count_as(:'A', 'select 1 from public.profiles') = 5, 'branch admin sees the whole Bilaspur team');
select t.allowed(:'A', format($q$insert into public.memberships (user_id, branch_id, role, created_by) values (%L, %L, 'counter', %L)$q$, :'Z', :'BIL', :'A'), 1, 'branch admin can add a counter');
select t.denied(:'A', format($q$insert into public.memberships (user_id, branch_id, role) values (%L, %L, 'admin')$q$, :'J', :'BIL'), 'branch admin cannot create another admin (owner only)');
select t.denied(:'A', format($q$update public.memberships set role = 'admin' where user_id = %L and branch_id = %L$q$, :'M', :'BIL'), 'branch admin cannot promote a manager to admin');
select t.allowed(:'A', format($q$update public.memberships set role = 'manager' where user_id = %L and branch_id = %L$q$, :'C2', :'BIL'), 1, 'branch admin can promote a counter to manager');
select t.allowed(:'A', format($q$update public.memberships set active = false where user_id = %L and branch_id = %L$q$, :'C2', :'BIL'), 1, 'branch admin can deactivate a helper');
select t.no_effect(:'A', format($q$update public.memberships set active = false where user_id = %L$q$, :'A'), 'branch admin cannot deactivate themselves/other admins');
select t.denied(:'A', format($q$insert into public.branches (code, name) values ('2', 'Nope')$q$), 'branch admin cannot create a branch');
select t.no_effect(:'A', format($q$update public.profiles set is_owner = true where user_id = %L$q$, :'A'), 'branch admin cannot make themselves owner');
select t.denied(:'A', format($q$delete from public.memberships where user_id = %L$q$, :'C1'), 'nobody deletes memberships (they are deactivated instead)');
select t.denied(:'A', format($q$update public.memberships set user_id = %L where user_id = %L$q$, :'Z', :'C1'), 'membership owner column cannot be changed');
select t.denied(:'A', format($q$update public.branches set code = '9' where id = %L$q$, :'BIL'), 'SAP branch code is immutable');

-- ------------------------------------------------------------------ audit trail
select t.check((select count(*) from public.audit_log where actor = :'A'::uuid and table_name = 'memberships' and action = 'INSERT') = 1, 'audit log records who added the counter');
select t.check((select old_data ->> 'role' from public.audit_log where actor = :'A'::uuid and action = 'UPDATE' and row_key = :'C2' order by id limit 1) = 'counter', 'audit log keeps the OLD role when it changes');
select t.check(t.count_as(:'A', 'select 1 from public.audit_log') >= 3, 'branch admin can read their branch audit log');
select t.check(t.count_as(:'A', format($q$select 1 from public.audit_log where branch_id = %L$q$, :'JHA')) = 0, 'branch admin cannot read another branch audit log');
select t.denied(:'A', 'delete from public.audit_log', 'audit log cannot be deleted by users');
select t.denied(:'O', 'update public.audit_log set action = ''x''', 'audit log cannot be altered even by the owner');

-- ------------------------------------------------------------------ owner
select t.check((select count(*) from public.branches where code = '6696') = 1, 'seed migration created Bilaspur (code 6696) exactly once');
select t.check(t.count_as(:'O', 'select 1 from public.branches') = 2, 'owner sees every branch');
select t.allowed(:'O', format($q$insert into public.branches (code, name) values ('7002', 'Jharli')$q$), 1, 'owner can add a new branch (Jharli)');
select t.check(t.count_as(:'O', 'select 1 from public.branches') = 3, 'new branch appears for the owner with no code change');
select t.allowed(:'O', format($q$insert into public.memberships (user_id, branch_id, role) values (%L, %L, 'admin')$q$, :'A', :'JHA'), 1, 'owner can make someone admin of another branch');
select t.check(t.count_as(:'A', 'select 1 from public.branches') = 2, 'that admin now sees both branches');
do $$ begin
  begin insert into public.branches (code, name) values ('6696', 'Duplicate'); raise exception 'FAIL - duplicate branch code accepted';
  exception when unique_violation then perform t.pass('duplicate SAP branch code is rejected'); end;
end $$;

-- ------------------------------------------------------------------ deactivated people lose access
select t.check(t.count_as(:'X', 'select 1 from public.branches') = 0, 'deactivated person sees no branch even with an old membership');
select t.check(t.count_as(:'X', 'select 1 from public.memberships') = 1, 'deactivated person can only see their own (inactive) row');
select t.check(t.count_as(:'Z', 'select 1 from public.branches') = 1, 'person added to a branch sees it immediately');
select t.check(t.count_as(:'C2', 'select 1 from public.branches') = 0, 'deactivated helper loses the branch');

-- ------------------------------------------------------------------ owner safety
do $$ begin
  begin update public.profiles set active = false where is_owner; raise exception 'FAIL - last owner could be deactivated';
  exception when sqlstate 'P0001' then perform t.pass('the last active owner cannot be deactivated'); end;
  begin delete from auth.users where id = '00000000-0000-0000-0000-0000000000a1'; raise exception 'FAIL - last owner login could be deleted';
  exception when sqlstate 'P0001' then perform t.pass('the last active owner cannot be deleted'); end;
  begin perform public.bootstrap_owner('ua9@example.test', 'Second'); raise exception 'FAIL - bootstrap ran twice';
  exception when others then
    if sqlerrm like '%already exists%' then perform t.pass('bootstrap_owner refuses to run once an owner exists'); else raise; end if; end;
end $$;
insert into public.profiles (user_id, full_name, is_owner) values (:'O2', 'Owner Two', true);
select t.allowed(:'O', format($q$update public.profiles set active = false where user_id = %L$q$, :'O2'), 1, 'with two owners, one can be deactivated');
select t.check(t.count_as(:'O2', 'select 1 from public.branches') = 0, 'a deactivated owner has no powers left');
select t.denied(:'A', 'select public.bootstrap_owner(''a@b.c'', ''x'')', 'logged-in users cannot call bootstrap_owner');

select 'ALL DONE' as result;
