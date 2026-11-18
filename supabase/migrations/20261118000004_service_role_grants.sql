-- The server-side key (service_role) is used only by the team-admin Edge Function. It bypasses Row Level Security but still
-- needs table privileges. Supabase's "Grant API access to new tables automatically" can be OFF (it is on this project), in which
-- case nothing is granted by default - so grant exactly what the function needs, explicitly. Safe to run more than once.
grant usage on schema public to service_role;
grant select, insert, update, delete on public.branches, public.profiles, public.memberships, public.audit_log to service_role;
grant usage, select on all sequences in schema public to service_role;
