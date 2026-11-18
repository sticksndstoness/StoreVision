# StoreVision Count

Mobile web app for stock counting: photograph a part label (Gemini reads Part No, barcode, MRP, mfg date), photograph a rack (Gemini detects the bay tag and plots numbered pins on each visible unit), correct the pins by hand, apply a depth multiplier, and sync each count to a Google Sheet.

> AI counts are **estimates**. Always check the pins against the photo before saving.

## Files
| Path | Purpose |
|---|---|
| `index.html`, `css/style.css` | UI |
| `js/core.js` | Pure logic (totals, validation, CSV, escaping) — unit tested |
| `js/app.js` | DOM, Gemini calls, storage, sync |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installable PWA + offline app shell |
| `apps-script/Code.gs` | Google Sheet backend + optional Gemini proxy |
| `tests/` | `npm test` (unit), `npm run test:e2e` (Playwright, mocked network) |

## Setup
1. **Sheet backend:** follow the header comment in `apps-script/Code.gs` (set `TOKEN`, deploy as Web App). 
2. **Host the app** over HTTPS (GitHub Pages, Netlify…). Camera, service worker and clipboard need HTTPS.
3. In the app tap **Setup**: paste the Web App URL and the same token.
4. **AI key — pick one:**
   - *Recommended:* tick "Use Apps Script as AI proxy" and put `GEMINI_API_KEY` in Script Properties. The key never reaches the phone.
   - *Direct:* paste the key in Setup (stored in this browser only). Restrict it in Google Cloud to the Generative Language API.

## Choosing the Gemini model
Setup → **Gemini Model** is a dropdown. The default is `gemini-3.8-flash`. Tap **Check available models** to ask Google which models your key can use (works in direct mode, or in proxy mode via the script), pick one, and Save. Choose *Custom model ID…* to type any ID. If Google retires a model, the error message tells you to come back here.

## Sync behaviour
Each entry has a status: **Synced / Not synced / Sync failed**. It only becomes *Synced* when the script answers `{"ok":true}`. Failed rows keep a Retry button, and edits re-sync the same row (upsert by id — no duplicates). Deleting locally does **not** delete the Sheet row.

## Known limitations
- Tailwind is loaded from the Play CDN (pinned to 3.4.17) — fine for internal use; compile CSS with the Tailwind CLI for production.
- No Subresource Integrity hashes on CDN assets.
- Pins are renumbered after a removal (Undo is provided).
- Apps Script sync/proxy is untested against a live deployment in CI.
