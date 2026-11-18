-- SAP stock snapshots: the "book" figures the physical count is compared against.
--   * Counters can NEVER read these tables (blind counting). Only branch admins/managers (and owners) can.
--   * Uploading goes through ONE function, import_sap_snapshot(): it checks the caller is an admin of the branch, checks the
--     file's SAP branch code matches the branch, validates every row, flips the "current" snapshot and inserts atomically.
--   * Old snapshots are kept (history); exactly one snapshot per branch is "current".

alter table public.branches add column sensitive_threshold numeric(12, 2) not null default 10000 check (sensitive_threshold > 0);
grant update (sensitive_threshold) on public.branches to authenticated;     -- changeable by owners only (existing RLS)

create table public.sap_snapshots (
  id                  uuid primary key default gen_random_uuid(),
  branch_id           uuid not null references public.branches (id),
  uploaded_by         uuid references auth.users (id),
  uploaded_at         timestamptz not null default now(),
  file_name           text not null,
  report_date         date,
  line_count          integer not null,          -- lot rows in the file
  part_count          integer not null,
  row_count           integer not null,          -- part/bin lines stored
  total_qty           numeric not null,
  total_value         numeric not null,
  sensitive_threshold numeric(12, 2) not null,   -- the threshold used when this snapshot was imported
  is_current          boolean not null default true
);
create unique index sap_snapshots_one_current on public.sap_snapshots (branch_id) where is_current;
create index sap_snapshots_branch_time_idx on public.sap_snapshots (branch_id, uploaded_at desc);

create table public.sap_stock (
  snapshot_id   uuid not null references public.sap_snapshots (id) on delete cascade,
  branch_id     uuid not null references public.branches (id),
  part_code     text not null,
  bin           text not null,
  description   text not null default '',
  uom           text not null default '',
  book_qty      numeric not null,                -- physical stock per SAP: available + reserved + blocked
  available_qty numeric not null default 0,
  blocked_qty   numeric not null default 0,
  unit_cost     numeric(14, 2) not null default 0,
  mrp           numeric(14, 2) not null default 0,
  is_sensitive  boolean not null default false,
  primary key (snapshot_id, part_code, bin)
);
create index sap_stock_branch_idx on public.sap_stock (branch_id, snapshot_id);

alter table public.sap_snapshots enable row level security;
alter table public.sap_stock     enable row level security;

create policy sap_snapshots_select on public.sap_snapshots for select to authenticated
  using (public.has_branch_role(branch_id, array['admin', 'manager']::public.app_role[]));
create policy sap_stock_select on public.sap_stock for select to authenticated
  using (public.has_branch_role(branch_id, array['admin', 'manager']::public.app_role[]));

-- audit: generalise the trigger so it understands tables that carry a branch_id
create or replace function public.log_audit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare r jsonb; b uuid; k text;
begin
  if tg_op = 'DELETE' then r := to_jsonb(old); else r := to_jsonb(new); end if;
  b := case tg_table_name when 'branches' then (r ->> 'id')::uuid else nullif(r ->> 'branch_id', '')::uuid end;
  k := coalesce(r ->> 'id', r ->> 'user_id');
  insert into public.audit_log (actor, branch_id, table_name, row_key, action, old_data, new_data)
  values ((select auth.uid()), b, tg_table_name, k, tg_op,
          case when tg_op <> 'INSERT' then to_jsonb(old) end, case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke all on function public.log_audit() from public, anon, authenticated;
create trigger audit_sap_snapshots after insert or update on public.sap_snapshots for each row execute function public.log_audit();

create function public.import_sap_snapshot(p_branch uuid, p_file_name text, p_report_date date, p_branch_code text, p_line_count integer, p_rows jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.branches%rowtype; sid uuid; n integer; parts integer; tq numeric; tv numeric;
begin
  if not public.has_branch_role(p_branch, array['admin']::public.app_role[]) then
    raise exception 'You are not allowed to upload SAP stock for this branch.' using errcode = '42501';
  end if;
  select * into b from public.branches where id = p_branch and active;
  if not found then raise exception 'That branch is not available.' using errcode = '22023'; end if;
  if btrim(coalesce(p_branch_code, '')) <> b.code then
    raise exception 'This file is for SAP branch code "%" but you chose % (code "%"). Nothing was uploaded.', coalesce(p_branch_code, '?'), b.name, b.code using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then raise exception 'The stock data is not valid.' using errcode = '22023'; end if;
  n := jsonb_array_length(p_rows);
  if n < 1 or n > 60000 then raise exception 'The file must contain between 1 and 60000 stock lines.' using errcode = '22023'; end if;

  if exists (select 1 from jsonb_to_recordset(p_rows) as r(part_code text, bin text, book_qty numeric)
             where coalesce(btrim(r.part_code), '') = '' or coalesce(btrim(r.bin), '') = '' or r.book_qty is null) then
    raise exception 'Some stock lines are missing a part code, bin or quantity.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_to_recordset(p_rows) as r(part_code text, bin text) group by r.part_code, r.bin having count(*) > 1) then
    raise exception 'The same part appears twice in the same bin. Nothing was uploaded.' using errcode = '22023';
  end if;

  select count(distinct r.part_code), coalesce(sum(r.book_qty), 0), coalesce(sum(r.book_qty * coalesce(r.unit_cost, 0)), 0)
    into parts, tq, tv from jsonb_to_recordset(p_rows) as r(part_code text, book_qty numeric, unit_cost numeric);

  update public.sap_snapshots set is_current = false where branch_id = p_branch and is_current;
  insert into public.sap_snapshots (branch_id, uploaded_by, file_name, report_date, line_count, part_count, row_count, total_qty, total_value, sensitive_threshold)
  values (p_branch, (select auth.uid()), left(coalesce(p_file_name, ''), 200), p_report_date, greatest(coalesce(p_line_count, n), 0), parts, n, tq, tv, b.sensitive_threshold)
  returning id into sid;

  insert into public.sap_stock (snapshot_id, branch_id, part_code, bin, description, uom, book_qty, available_qty, blocked_qty, unit_cost, mrp, is_sensitive)
  select sid, p_branch, btrim(r.part_code), btrim(r.bin), left(coalesce(r.description, ''), 200), left(coalesce(r.uom, ''), 10), r.book_qty,
         coalesce(r.available_qty, 0), coalesce(r.blocked_qty, 0), coalesce(r.unit_cost, 0), coalesce(r.mrp, 0), coalesce(r.unit_cost, 0) > b.sensitive_threshold
  from jsonb_to_recordset(p_rows) as r(part_code text, bin text, description text, uom text, book_qty numeric, available_qty numeric, blocked_qty numeric, unit_cost numeric, mrp numeric);
  return sid;
end $$;

-- explicit grants (this project grants nothing by default)
revoke all on public.sap_snapshots, public.sap_stock from anon, authenticated;
revoke all on function public.import_sap_snapshot(uuid, text, date, text, integer, jsonb) from public, anon;
grant select on public.sap_snapshots, public.sap_stock to authenticated;
grant execute on function public.import_sap_snapshot(uuid, text, date, text, integer, jsonb) to authenticated;
grant select, insert, update, delete on public.sap_snapshots, public.sap_stock to service_role;
