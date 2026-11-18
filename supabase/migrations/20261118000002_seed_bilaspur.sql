-- First branch. 6696 is the SAP "Branch Code" printed in the Bilaspur stock report.
-- Jhajjar and Jharli are added later by an owner from the app (or the same insert) - no code change needed.
insert into public.branches (code, name) values ('6696', 'Bilaspur') on conflict (code) do nothing;
