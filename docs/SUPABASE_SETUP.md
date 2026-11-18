# Supabase setup (one-time, ~10 minutes)

Do this in the **StoreVision** Supabase project (not the stock-trader one).

## 1. Lock down sign-ups
Authentication → Sign In / Providers → **Email**:
- Turn **off** "Allow new users to sign up" (people are added by an admin, never self-registered).
- Leave "Confirm email" as you like; users you create below are auto-confirmed.

## 2. Apply the database setup
Pick one:
- **Automatic (GitHub link):** the files in `supabase/migrations/` are applied when this repository's `main` branch changes. Check Project Settings → Integrations → GitHub that it points at `sticksndstoness/StoreVision`, branch `main`, directory `supabase`.
- **Manual:** open **SQL Editor**, paste the contents of `supabase/migrations/20261118000001_foundation.sql`, run it. Do this for each later migration file, in order.

## 3. Create yourself as the first owner
1. Authentication → Users → **Add user** → your email + a strong password → tick *Auto Confirm User*.
2. SQL Editor, run (replace the email and name):
```sql
select public.bootstrap_owner('you@example.com', 'Your Name');
insert into public.branches (code, name) values ('6696', 'Bilaspur');
```
`6696` is the SAP *Branch Code* printed in the stock report; uploads will be checked against it so the wrong branch's file cannot be loaded by mistake.
Jhajjar and Jharli are added later from the app by an owner (or with the same `insert`) — no code change.

## 4. Send me
- **Project URL** (`https://xxxx.supabase.co`)
- **Publishable (or anon) key**

Never send the secret / service_role key or the database password.

## Roles in one table
| Role | Scope | Can |
|---|---|---|
| owner | all branches | everything, create branches, appoint admins |
| admin | one or more branches | add/deactivate managers and counters, upload SAP, see values |
| manager | one branch | review counts and variances, run the register, approve restocks |
| counter | one branch | count only (blind: no SAP quantity, no prices) |

People are never deleted, only deactivated. Every change is kept in `audit_log`.

## Testing the rules locally
`npm run test:db` starts a throwaway PostgreSQL, applies every migration and checks what each kind of user can and cannot do (no Supabase account needed; needs the `postgresql` package).
