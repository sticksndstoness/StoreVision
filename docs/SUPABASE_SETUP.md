# Supabase setup (one-time, ~10 minutes)

Do this in the **StoreVision** Supabase project (not the stock-trader one).

## 1. Lock down sign-ups
Authentication → Sign In / Providers → **Email**:
- Turn **off** "Allow new users to sign up" (people are added by an admin, never self-registered).
- Leave "Confirm email" as you like; users you create below are auto-confirmed.

## 2. Apply the database setup (automatic)
Project Settings → Integrations → GitHub:
- Repository `sticksndstoness/StoreVision`, working directory `.`
- Turn **Deploy to production** ON, production branch name `main`, Save.

From then on, every change merged into `main` under `supabase/migrations/` is applied to the database automatically
(this also creates the Bilaspur branch, code 6696). Do **not** also paste migrations by hand once this is on.
*Fallback if it ever does not apply:* SQL Editor → paste the migration files in filename order → Run.

## 3. Create yourself as the first owner
1. Authentication → Users → **Add user** → your email + a strong password → tick *Auto Confirm User*.
2. SQL Editor, run once (your email and name):
```sql
select public.bootstrap_owner('you@example.com', 'Your Name');
```
Jhajjar and Jharli are added later from the app by an owner - no code change.

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
