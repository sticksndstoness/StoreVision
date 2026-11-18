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
create function t.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', '', true); execute 'set local role service_role'; end $$;
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


-- ------------------------------------------------------------------ profile email (migration 3)
select t.check((select email from public.profiles where user_id = :'O') = 'ua1@example.test', 'bootstrap_owner stores the owner login email');
select t.denied(:'O', format($q$update public.profiles set email = 'x@y.z' where user_id = %L$q$, :'A'), 'the app can never write an email (server only)');
do $$ begin
  begin update public.profiles set email = 'UA1@example.test' where user_id = '00000000-0000-0000-0000-0000000000a2'; raise exception 'FAIL - duplicate email accepted (case-insensitive)';
  exception when unique_violation then perform t.pass('the same email cannot belong to two profiles (case-insensitive)'); end;
end $$;
select t.check(t.count_as(:'C1', 'select 1 from public.profiles where email is not null') <= 1, 'a counter can only ever see their own email, not colleagues');

-- ------------------------------------------------------------------ the server-side key (what the team-admin Edge Function uses)
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000c1', 'newperson@example.test');
do $$ declare n bigint; begin
  perform t.as_service();
  select count(*) into n from public.profiles where is_owner and active;                       -- loadPerson: read profile
  if n < 1 then raise exception 'FAIL - service key cannot read profiles'; end if;
  select count(*) into n from public.memberships; select count(*) into n from public.branches;   -- read memberships / branches
  insert into public.profiles (user_id, full_name, email, is_owner) values ('00000000-0000-0000-0000-0000000000c1', 'New Person', 'newperson@example.test', false);
  insert into public.memberships (user_id, branch_id, role, created_by) select '00000000-0000-0000-0000-0000000000c1', id, 'counter', null from public.branches where code = '6696';
  insert into public.audit_log (actor, branch_id, table_name, row_key, action, new_data) select null, id, 'team_action', 'x', 'create_user', '{}'::jsonb from public.branches where code = '6696';
  perform t.back();
  perform t.pass('service key can do everything create_user needs (read people, add profile + membership, write audit row)');
exception when insufficient_privilege then perform t.back(); raise exception 'FAIL - service key lacks a privilege the Edge Function needs: %', sqlerrm;
end $$;
do $$ begin
  perform t.as_service();
  update public.memberships set active = false where user_id = '00000000-0000-0000-0000-0000000000c1';
  perform t.back(); perform t.pass('service key can update memberships');
exception when insufficient_privilege then perform t.back(); raise exception 'FAIL - service key cannot update: %', sqlerrm;
end $$;
do $$ begin
  perform t.as_anon();
  begin insert into public.audit_log (table_name, action) values ('x', 'y'); raise exception 'FAIL - anon wrote to the audit log';
  exception when insufficient_privilege then perform t.back(); perform t.pass('the public key still cannot write the audit log'); end;
end $$;

-- ------------------------------------------------------------------ SAP snapshots (migration 5)
create function t.import_as(u uuid, b uuid, code text, rows jsonb) returns uuid language plpgsql as $$
declare sid uuid;
begin perform t.as_user(u); select public.import_sap_snapshot(b, 'Stock_Report_15.10.2026_Bilaspur_1.xlsx', date '2026-10-15', code, 3, rows) into sid; perform t.back(); return sid; end $$;
create function t.import_fails(u uuid, b uuid, code text, rows jsonb, expect text, msg text) returns void language plpgsql as $$
begin
  perform t.as_user(u);
  begin
    perform public.import_sap_snapshot(b, 'f.xlsx', null, code, 1, rows); perform t.back();
    raise exception 'FAIL - % (the upload was allowed)', msg;
  exception when others then
    perform t.back();
    if sqlstate = expect then perform t.pass(msg); else raise exception 'FAIL - % (expected SQLSTATE %, got % : %)', msg, expect, sqlstate, sqlerrm; end if;
  end;
end $$;

\set ROWS '[{"part_code":"AF-100","bin":"C01-E4","description":"AIR FILTER","uom":"EA","book_qty":8,"available_qty":8,"blocked_qty":0,"unit_cost":407.5,"mrp":650},{"part_code":"SENS-1","bin":"PLAT","description":"SPEED SENSOR","uom":"EA","book_qty":2,"available_qty":2,"blocked_qty":0,"unit_cost":12500,"mrp":15000},{"part_code":"OIL","bin":"18_C","description":"OIL","uom":"L","book_qty":12.5,"available_qty":12.5,"blocked_qty":0,"unit_cost":300,"mrp":420}]'
select t.import_as(:'A', :'BIL', '6696', :'ROWS'::jsonb) as sid1 \gset

select t.check((select count(*) from public.sap_stock where snapshot_id = :'sid1') = 3, 'branch admin can upload a SAP snapshot (3 lines stored)');
select t.check((select part_count = 3 and row_count = 3 and total_qty = 22.5 and is_current and report_date = date '2026-10-15' and file_name like 'Stock_Report%' from public.sap_snapshots where id = :'sid1'), 'snapshot records its totals, date, file name and is current');
select t.check((select array_agg(part_code order by part_code) from public.sap_stock where snapshot_id = :'sid1' and is_sensitive) = array['SENS-1'], 'only the part above the 10,000 threshold is flagged sensitive');
select t.check((select sensitive_threshold from public.sap_snapshots where id = :'sid1') = 10000, 'the threshold used is stored with the snapshot');

-- blind counting: who can read the book figures
select t.check(t.count_as(:'C1', 'select 1 from public.sap_stock') = 0, 'a counter cannot read SAP stock (blind counting)');
select t.check(t.count_as(:'C1', 'select 1 from public.sap_snapshots') = 0, 'a counter cannot even see that a snapshot exists');
select t.check(t.count_as(:'M', 'select 1 from public.sap_stock') = 3, 'a manager can read the SAP stock of their branch');
select t.check(t.count_as(:'O', 'select 1 from public.sap_stock') = 3, 'an owner can read it too');
select t.check(t.count_as(:'J', 'select 1 from public.sap_stock') = 0, 'an admin of another branch cannot read it');
select t.denied(:'A', format($q$insert into public.sap_stock (snapshot_id, branch_id, part_code, bin, book_qty) values (%L, %L, 'HACK', 'X', 5)$q$, :'sid1', :'BIL'), 'nobody inserts stock lines directly (upload function only)');
select t.denied(:'A', format($q$update public.sap_stock set book_qty = 999 where snapshot_id = %L$q$, :'sid1'), 'nobody edits stock figures after upload');
select t.denied(:'A', format($q$insert into public.sap_snapshots (branch_id, file_name, line_count, part_count, row_count, total_qty, total_value, sensitive_threshold) values (%L, 'x', 1, 1, 1, 1, 1, 1)$q$, :'BIL'), 'nobody creates snapshots directly');
select t.denied(:'A', format($q$delete from public.sap_snapshots where id = %L$q$, :'sid1'), 'nobody deletes snapshots');

-- who may upload
select t.import_fails(:'C1', :'BIL', '6696', :'ROWS'::jsonb, '42501', 'a counter cannot upload SAP stock');
select t.import_fails(:'M', :'BIL', '6696', :'ROWS'::jsonb, '42501', 'a manager cannot upload SAP stock (admin job)');
select t.import_fails(:'J', :'BIL', '6696', :'ROWS'::jsonb, '42501', 'an admin of another branch cannot upload into Bilaspur');
do $$ begin
  perform t.as_anon();
  begin perform public.import_sap_snapshot(null, 'f', null, '6696', 1, '[]'::jsonb); raise exception 'FAIL - the public key could call the upload function';
  exception when insufficient_privilege then perform t.back(); perform t.pass('the public key cannot call the upload function'); end;
end $$;

-- the wrong-branch safety net and bad data
select t.import_fails(:'A', :'BIL', '7001', :'ROWS'::jsonb, '22023', 'a file for another branch code is refused');
select t.import_fails(:'A', :'BIL', null, :'ROWS'::jsonb, '22023', 'a file with no branch code is refused');
select t.import_fails(:'A', :'BIL', '6696', '[]'::jsonb, '22023', 'an empty file is refused');
select t.import_fails(:'A', :'BIL', '6696', '{"a":1}'::jsonb, '22023', 'data that is not a list is refused');
select t.import_fails(:'A', :'BIL', '6696', '[{"part_code":"A","bin":"B1","book_qty":1},{"part_code":"A","bin":"B1","book_qty":2}]'::jsonb, '22023', 'the same part twice in one bin is refused');
select t.import_fails(:'A', :'BIL', '6696', '[{"part_code":"","bin":"B1","book_qty":1}]'::jsonb, '22023', 'a line without a part code is refused');
select t.import_fails(:'A', :'BIL', '6696', '[{"part_code":"A","bin":"B1"}]'::jsonb, '22023', 'a line without a quantity is refused');
select t.check((select count(*) from public.sap_snapshots where branch_id = :'BIL') = 1, 'every refused upload left nothing behind (still exactly 1 snapshot)');

-- history: a new upload becomes current, the old one is kept
select t.import_as(:'A', :'BIL', '6696', :'ROWS'::jsonb) as sid2 \gset
select t.check((select count(*) from public.sap_snapshots where branch_id = :'BIL') = 2 and (select count(*) from public.sap_snapshots where branch_id = :'BIL' and is_current) = 1, 'a second upload keeps history and exactly one snapshot is current');
select t.check((select is_current from public.sap_snapshots where id = :'sid2') and not (select is_current from public.sap_snapshots where id = :'sid1'), 'the newest snapshot is the current one');
select t.check((select count(*) from public.sap_stock where snapshot_id = :'sid1') = 3, 'the older snapshot keeps its lines');

-- the sensitive threshold is a branch setting (owner only)
select t.no_effect(:'A', format($q$update public.branches set sensitive_threshold = 1 where id = %L$q$, :'BIL'), 'a branch admin cannot change the sensitive threshold');
select t.allowed(:'O', format($q$update public.branches set sensitive_threshold = 350 where id = %L$q$, :'BIL'), 1, 'an owner can change the sensitive threshold');
select t.import_as(:'A', :'BIL', '6696', :'ROWS'::jsonb) as sid3 \gset
select t.check((select array_agg(part_code order by part_code) from public.sap_stock where snapshot_id = :'sid3' and is_sensitive) = array['AF-100', 'SENS-1'], 'a new threshold (350) flags the parts above it at the next upload');

-- audit and the server key
select t.check((select count(*) from public.audit_log where table_name = 'sap_snapshots' and actor = :'A'::uuid and action = 'INSERT' and branch_id = :'BIL'::uuid) = 3, 'every upload is in the audit log with who did it');
do $$ declare n bigint; begin
  perform t.as_service(); select count(*) into n from public.sap_stock; select count(*) into n from public.sap_snapshots; perform t.back();
  perform t.pass('the server key can read the SAP tables');
exception when insufficient_privilege then perform t.back(); raise exception 'FAIL - server key cannot read SAP tables: %', sqlerrm; end $$;

-- ------------------------------------------------------------------ part list for the counting phones (migration 6)
select t.check((select pg_get_function_result('public.part_list(uuid)'::regprocedure)) !~* '(qty|quantity|cost|mrp|value|sensitive|amount|price)', 'the part list function cannot return a quantity, cost, MRP or sensitivity column');
select t.check((select count(*) from pg_proc where proname = 'part_list') = 1, 'there is exactly one part_list function');
select t.check(t.count_as(:'C1', format($q$select 1 from public.part_list(%L) where total_rows = 3$q$, :'BIL')) = 3, 'every row carries total_rows so the phone can verify it received the whole list');
select t.check(t.count_as(:'C1', format($q$select * from public.part_list(%L)$q$, :'BIL')) = 3, 'a counter gets the 3 parts of the current snapshot (code, description, unit, bin)');
select t.check(t.count_as(:'M', format($q$select * from public.part_list(%L)$q$, :'BIL')) = 3, 'a manager gets it too');
select t.check(t.count_as(:'A', format($q$select * from public.part_list(%L)$q$, :'BIL')) = 3, 'a branch admin gets it too');
select t.check(t.count_as(:'O', format($q$select * from public.part_list(%L)$q$, :'BIL')) = 3, 'an owner gets it too');
select t.check(t.count_as(:'J', format($q$select * from public.part_list(%L)$q$, :'BIL')) = 0, 'a member of another branch gets nothing for Bilaspur');
select t.check(t.count_as(:'X', format($q$select * from public.part_list(%L)$q$, :'BIL')) = 0, 'a deactivated person gets nothing');
select t.check(t.count_as(:'C2', format($q$select * from public.part_list(%L)$q$, :'BIL')) = 0, 'a deactivated helper gets nothing');
select t.check(t.count_as(:'C1', format($q$select * from public.part_list(%L)$q$, :'JHA')) = 0, 'a Bilaspur helper gets nothing for another branch');
select t.check(t.count_as(:'C1', format($q$select * from public.part_list(%L) where snapshot_id <> %L$q$, :'BIL', :'sid3')) = 0, 'only the CURRENT snapshot is listed (never an older one)');
select t.check((select string_agg(part_code || '@' || bin, ',' order by part_code) from public.part_list(:'BIL'::uuid)) is null, 'sanity: with no logged-in user the function returns nothing');
do $$ begin
  perform t.as_anon();
  begin perform * from public.part_list('00000000-0000-0000-0000-000000000000'); raise exception 'FAIL - the public key could call part_list';
  exception when insufficient_privilege then perform t.back(); perform t.pass('the public key cannot call part_list'); end;
end $$;

select 'ALL DONE' as result;
