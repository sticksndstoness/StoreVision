-- The part list for the counting phones: WHAT can be counted and WHERE it lives - never how many or what it costs.
-- Counters cannot read sap_stock (blind counting), so they get this narrow, read-only view of it instead.
-- Returns the CURRENT snapshot's part code, description, unit and bin only. No quantities, no cost, no MRP, no sensitivity flag.
-- total_rows lets the phone check it received the WHOLE list (the API returns at most 1000 rows per request).
-- Available to any active member of the branch (counter, manager, admin) and to owners.
create function public.part_list(p_branch uuid)
returns table (snapshot_id uuid, part_code text, description text, uom text, bin text, total_rows bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  select s.snapshot_id, s.part_code, s.description, s.uom, s.bin, count(*) over ()
  from public.sap_stock s
  join public.sap_snapshots sn on sn.id = s.snapshot_id and sn.is_current
  where s.branch_id = p_branch
    and public.has_branch_role(p_branch, array['admin', 'manager', 'counter']::public.app_role[])
  order by s.bin, s.part_code
$$;
revoke all on function public.part_list(uuid) from public, anon;
grant execute on function public.part_list(uuid) to authenticated;
