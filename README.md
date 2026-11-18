# StoreVision Count

Mobile web app for stock counting: photograph a part label (Gemini reads Part No, barcode, MRP, mfg date), photograph a rack (Gemini detects the bay tag and plots numbered pins on each visible unit), correct the pins by hand, apply a depth multiplier, and sync each count to a Google Sheet.

> AI counts are **estimates**. Always check the pins against the photo before saving.

## Files
| Path | Purpose |
|---|---|
| `index.html`, `css/style.css`, `css/tailwind.css` | UI. `tailwind.css` is **generated** — run `npm run build:css` after changing classes in `index.html` / `js/` and commit the result |
| `vendor/fontawesome/` | Self-hosted icons (no CDN) |
| `js/core.js` | Pure logic (totals, validation, change tracking, backups, CSV) — unit tested |
| `js/db.js` | Storage: IndexedDB, audit log, drafts, crash log, backup/restore |
| `js/app.js` | DOM, Gemini calls, sync |
| `js/sap.js`, `js/stock.js`, `vendor/readxlsx/` | SAP stock report reader (xlsx/csv) and the upload screen |
| `js/cloud.js`, `js/team.js`, `js/config.js` | Sign-in, Team and Branches screens (Supabase). Public key only in `config.js` |
| `supabase/` | Database migrations (RLS) and the `team-admin` Edge Function. `tools/` builds the single-file function (`npm run build:fn`) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installable PWA + offline app shell |
| `apps-script/Code.gs` | Google Sheet backend + optional Gemini proxy |
| `tests/` | `npm test` (unit) and `npm run test:browser` (Playwright, mocked network). CI: `.github/workflows/test.yml` |

## Setup
1. **Sheet backend:** follow the header comment in `apps-script/Code.gs` (set `TOKEN`, deploy as Web App). 
2. **Host the app** over HTTPS (GitHub Pages, Netlify…). Camera, service worker and clipboard need HTTPS.
3. In the app tap **Setup**: paste the Web App URL and the same token.
4. **AI key — pick one:**
   - *Recommended:* tick "Use Apps Script as AI proxy" and put `GEMINI_API_KEY` in Script Properties. The key never reaches the phone.
   - *Direct:* paste the key in Setup (stored in this browser only). Restrict it in Google Cloud to the Generative Language API.

## Data safety (v2.1)
- Counts are stored in **IndexedDB** and the app asks the browser not to evict them. v2 data is migrated automatically; the old copy is kept under `sv_inventory_log_migrated`.
- Nothing is overwritten silently: every create / edit / delete is also written to an **append-only audit log** with the full before/after, so a deleted or edited entry can always be recovered (it is included in backups).
- **Drafts autosave** while you count and are restored after a reload, crash or phone call.
- **Setup → Data safety & diagnostics:** download / restore a backup (restore only adds missing entries, never overwrites), see storage status, copy the error log. A reminder appears if there has been no backup for 7 days.
- A global error handler records crashes, clears any stuck "scanning" overlay and shows a banner; saves are confirmed written before the form is cleared; double-taps cannot create duplicates.
- Hardened delivery: no third-party scripts, styles or fonts; a Content-Security-Policy restricts what the page can load or call; the app starts offline.
- AI calls are rate-limited (1 per second, 400 per day) to avoid runaway taps and surprise bills.

## Shared backend (in progress)
The multi-branch, role-based backend (Supabase) is being added in steps. Setup instructions: `docs/SUPABASE_SETUP.md`. Database rules live in `supabase/migrations/` and are tested with `npm run test:db`.

## SAP stock upload (admins / owners)
Account → **SAP stock** → choose the branch → choose the SAP *Stock Report* (.xlsx or .csv). The app shows what it found and blocks the upload if anything is unsafe:
a cut-off export (the title row's "Total Number of Lines" must match), a file that mixes branches, unreadable numbers, a file whose **Branch Code** is not the branch you chose, or no report date.
Rules used: lot rows are summed per part and bin; the book quantity is **Total Quantity** (available + reserved + blocked); *Issued Quantity* and *In-Transit* are ignored; parts with unit cost above the branch threshold (default ₹10,000) are flagged sensitive.
Each upload becomes the branch's *current* SAP stock; older ones are kept. **Counters can never read SAP stock** (enforced in the database; tested with `npm run test:db`).

## Choosing the Gemini model
Setup → **Gemini Model** is a dropdown. The default is `gemini-3.8-flash`. Tap **Check available models** to ask Google which models your key can use (works in direct mode, or in proxy mode via the script), pick one, and Save. Choose *Custom model ID…* to type any ID. If Google retires a model, the error message tells you to come back here.

## Sync behaviour
Each entry has a status: **Synced / Not synced / Sync failed**. It only becomes *Synced* when the script answers `{"ok":true}`. Failed rows keep a Retry button, and edits re-sync the same row (upsert by id — no duplicates). Deleting locally does **not** delete the Sheet row.

## Known limitations
- Data is still per-device until the shared backend (Supabase) is added; take backups.
- If you add a new backend host, add it to `connect-src` in the CSP `<meta>` in `index.html`.
- Pins are renumbered after a removal (Undo is provided).
- Apps Script sync/proxy is untested against a live deployment in CI.
