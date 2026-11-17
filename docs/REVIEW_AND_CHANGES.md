# StoreVision Count — Review & Change Report (v1 → v2)

**Repo:** sticksndstoness/StoreVision · **Branch:** `claude/stoic-meitner-2y0f7z`
**Scope:** whole app (originally one 586-line `index.html`). A static, client-side PWA: Gemini Vision reads labels and counts stacked units; counts are logged in `localStorage` and pushed to a Google Sheet via an Apps Script webhook.

## 1. Verification summary
| Check | Result |
|---|---|
| Unit tests (`node tests/core.test.js`) | 10/10 pass |
| Playwright E2E, mocked Gemini + Apps Script (`node tests/e2e.js`) | 19/19 pass, no page errors |
| Real Gemini API / real Apps Script deployment | **NOT tested** (no keys or network access here) |
| Real phone camera / HEIC photos / iOS Safari | **NOT tested** |
| Tailwind build, SRI hashes | **NOT done** (see §4) |

Testing caught one bug in my own first draft: `normalisePins` accepted `null` items and null coordinates as pins at (0,0) because `Number(null) === 0`. Fixed and covered by a test.

## 2. Findings in v1 and what changed

### Security
| # | v1 problem | v2 fix |
|---|---|---|
| S1 | **Stored XSS**: OCR/typed text injected via `innerHTML` in the log | All values escaped (`escapeHtml`); E2E test feeds `<img onerror>` as a part number and confirms it doesn't run |
| S2 | Gemini key in URL query string (`?key=`), visible in logs/history | Sent in `x-goog-api-key` header |
| S3 | Gemini key stored on the phone | New **Apps Script proxy mode**: key lives only in Script Properties; the app calls `action:'vision'` on the script |
| S4 | Webhook unauthenticated (URL was the only secret) | Shared **TOKEN** required on every request (constant-length compare); settings reject non-`script.google.com` URLs |
| S5 | CSV / Sheet formula injection (`=`, `+`, `-`, `@`) | Prefixed with `'` in CSV export and in `Code.gs` before writing to the Sheet |
| S6 | Unpinned Tailwind CDN | Pinned to 3.4.17 (SRI/build still open, §4) |

### Correctness
| # | v1 problem | v2 fix |
|---|---|---|
| C1 | `no-cors` fetch made **every sync look successful**, even on 500/wrong URL | CORS-readable JSON reply; entry is `synced` only on `{ok:true}`; otherwise `failed`. Per-entry status badge, per-row Retry, "Retry N" for all. Edits upsert by `id` (no duplicate rows) |
| C2 | "Hidden" column held a different number than the "Hidden +Qty" field | Saved separately: `hiddenQty` (typed), `depthMult`, `visibleCount`, `totalQty`. Field relabelled "Extra Qty"; formula shown in UI |
| C3 | Quantity formula duplicated in two places | Single `computeTotals()` used by display and saved entry |
| C4 | AI bay tag never replaced an old zone | Zone auto-fills unless the user typed it (`zoneManual`) |
| C5 | Form kept stale values after saving → accidental duplicates | Form, pins and photos reset after save (zone kept for the next SKU) |
| C6 | Model output not validated (NaN pins, bad JSON) | `responseSchema` enforced + `normalisePins` validation; clear error messages for blocked/truncated/empty/invalid-JSON replies; `maxOutputTokens` 8192 |
| C7 | Re-count wiped the user's manual pins | Manual pins are preserved on Re-Count |
| C8 | Same SKU+zone could be logged twice silently | Confirm dialog on same-day duplicate; qty 0 asks for confirmation |
| C9 | Hang forever if image couldn't decode (no `onerror`); same photo couldn't be re-selected | `onerror` handlers with messages; file input reset after each use |
| C10 | No network timeout / offline handling | 45 s AbortController timeout; offline badge; friendly errors |
| C11 | Corrupt/full `localStorage` bricked or silently lost data | Guarded reads/writes; user is warned to export CSV if saving fails |

### Data & log
- Entries now have `id`, ISO timestamp, `aiCounted`, `edited`, `syncStatus`. v1 logs are auto-migrated.
- **Edit quantity**, **Delete with Undo**, **Clear log** (warns about unsynced rows). Deleting does not remove the Sheet row (the UI says so).
- CSV: UTF-8 BOM (Excel), CRLF, all new columns, formula-safe.

### UX / accessibility
- Pinch-zoom re-enabled (removed `user-scalable=no`).
- Added a **gallery** picker next to each camera button (v1 forced camera only).
- Pins: 26 px visible with ~44 px touch target; remove has **Undo**; "AI counts are estimates — verify" notice; value shown as "≈" when AI-counted.
- Real `<label for>`, `aria-label`s on pins, `role="dialog"`, `aria-live` toast and totals, Esc closes Setup, toast lasts longer for long messages and supports an action button.
- Share uses the native share sheet when available, falls back to clipboard, then to a copy prompt; says when the list is truncated.
- PWA: `manifest.webmanifest` + `sw.js` (offline app shell; API calls never cached).

### Structure
Split into `index.html`, `css/style.css`, `js/core.js` (pure, unit-tested), `js/app.js` (no inline handlers). Model name is configurable in Setup. Added `apps-script/Code.gs` (previously missing from the repo), README, `.gitignore`, `package.json`, tests.

## 3. Setup changes the owner must make
1. Deploy the **new** `Code.gs` and set Script Properties `TOKEN` (and `GEMINI_API_KEY` for proxy mode). Existing old scripts will **not** work with v2: they don't return JSON or check the token.
2. Enter the same token in the app's Setup.
3. Host over HTTPS.

## 4. Not done / residual risks (be honest)
1. **Tailwind still comes from the Play CDN** (pinned, but not for production, and it needs network on first load). Needs a Tailwind CLI build.
2. **No SRI hashes** on CDN scripts/styles (couldn't compute them offline).
3. **Apps Script cross-origin behaviour is unverified live.** Reading the JSON reply relies on Apps Script's CORS headers after its redirect. If a deployment doesn't allow it, entries show "Sync failed" (safe) rather than a false success, but you would then need to adjust.
4. **Direct mode still keeps the Gemini key in the browser** (header, not URL). Use proxy mode for anything shared.
5. **AI counting accuracy is unmeasured.** Prompts and schema improved, but dense stacks will still be miscounted; the human pin review is the control. A labelled test set of real rack photos would be needed to quantify accuracy.
6. Deleting/editing locally leaves the original Sheet row (edits upsert, deletes don't propagate).
7. Pins renumber after removal (Undo mitigates).
8. Token check protects the webhook, but the token lives in `localStorage` on the device.

## 5. Suggested next steps
Compile Tailwind; add live Apps Script integration test; build a small labelled photo set to benchmark count accuracy and tune the prompt/model; optional delete-propagation; per-user auth if multiple counters share one Sheet.
