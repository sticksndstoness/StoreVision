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

## 4. Deploy the team function (lets you add people from the app)
The app creates logins through a small server function, because creating a login needs a key that must never be in a phone or browser.
1. Open **Edge Functions**. If `team-admin` is already listed (the GitHub link may deploy it), skip to step 4.
2. Otherwise click **Deploy a new function → Via Editor**, name it exactly `team-admin`.
3. Replace the editor contents with the whole of `supabase/functions/team-admin/index.ts` from the repo, then **Deploy**.
4. Open the function's settings and switch **Verify JWT** OFF (the function checks who is calling by itself). Save.
Nothing to configure: Supabase gives the function its own server key automatically. Change the function only by editing `tools/team-admin.handler.ts` or `supabase/functions/team-admin/logic.mjs` and running `npm run build:fn`.

## 5. Sign in to the app
Open the app → the person icon → sign in with the owner email and password → **Branches** to add Jhajjar and Jharli (type their SAP branch codes) → **Team** to add the manager, admins and helpers.

## 6. Send me
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
