# StoreVision — Audit, Market Comparison & Roadmap (v2 → v3)

Status of this document: written after v2 was merged. Claims about *this app* were checked against the code
(`grep` confirmed: no CSP, no SRI hashes, no `navigator.storage.persist()`, no draft autosave, no global error
handler, no CI). Claims about *other products* come from general knowledge, **not** live research — verify current
features and pricing before buying anything.

---

> **Update (v2.1):** roadmap step 1 (hardening) is implemented — see the README section "Data safety". The weaknesses
> numbered 1, 6, 7 and 10 below are addressed; 2, 3, 4, 5, 8, 9, 11, 12 are still open.

## 1. Honest audit of the current app

### 1.1 What it actually is
A single-device, single-user **counting aid**. It is not yet an inventory *system*: there is no book (SAP) stock to
compare against, no users, no movement history, and the only copy of the data lives in one browser.

### 1.2 Strengths (real ones)
- Fast capture flow for a warehouse floor (label → stack photo → pins → save). Good phone ergonomics.
- AI visual counting of stacked, *unbarcoded* cartons is something most competitors don't offer.
- Local-first saves, retry-able sync, upsert by id, CSV export, tested core logic (13 unit + 4 browser suites).

### 1.3 Weaknesses, ranked by how much they can hurt you

| # | Weakness | Why it matters |
|---|---|---|
| 1 | **Data lives only in `localStorage` on one phone** | Clearing Safari data, iOS storage eviction (Safari can purge site data after ~7 days of non-use in a browser tab), a lost/broken phone = **all counts gone**. This is the biggest risk for a "rigid, crash-resistant" goal. |
| 2 | **No identity, roles or audit trail** | Cannot tell who counted/edited/deleted what. Edit and Delete overwrite history. For stock-theft control this is disqualifying. |
| 3 | **No reference stock (SAP) → cannot reconcile** | Counting without a book figure only produces a list, not findings. |
| 4 | **AI counts are unverified estimates used as numbers** | LLM counting of dense stacks is unreliable; accuracy on your racks has never been measured. It must be an *assist*, never the control. |
| 5 | **Barcodes are read by an LLM, not decoded** | Reading a barcode as text via Gemini can misread digits and costs money per scan. A real barcode decoder is deterministic, free and instant. |
| 6 | **In-progress work is not saved** | A crash, call, or accidental reload mid-count loses pins/photo/typed fields (no draft autosave). |
| 7 | **No global error handling** | An unexpected exception can leave the UI stuck (e.g. a scanning overlay) with no log to diagnose. |
| 8 | **No part/location master data** | Free-text part numbers and bay names → `D1`, `d1`, `D-1` become different bays; SKUs mismatch SAP codes. |
| 9 | **Gemini key on the phone (direct mode); webhook token in the browser** | Acceptable for one owner, not for sharing with staff. |
| 10 | **Supply chain / hardening gaps** | Tailwind Play CDN (dev tool) in production, no SRI, no Content-Security-Policy, no CI running the tests. |
| 11 | **No units of measure, batch, serial** | Sensors and similar parts need serial-level tracking. |
| 12 | **No evidence retention** | Photos are discarded after counting; nothing to show in a dispute. |

### 1.4 What "crash-resistant and rigid" concretely requires
1. **IndexedDB** (not `localStorage`) + `navigator.storage.persist()` so the browser can't silently evict data.
2. **Append-only event log** (never overwrite): every count, edit, delete is a new record with user + timestamp.
   Current state is *derived* from events. This is what makes it tamper-evident and recoverable.
3. **Draft autosave** of the in-progress count every few seconds; restore prompt on reopen.
4. **Server of record** (see §4) with an **offline outbox**: writes queue locally, sync later, idempotent by id.
5. **Global error/rejection handlers** with a visible "something went wrong — your data is safe" screen and a local crash log.
6. **Schema versioning + migrations**, tested against old exports.
7. **Backups**: automatic weekly export to a place the owner controls + "download backup" button.
8. **Input validation everywhere**, bounded AI calls (timeouts exist; add rate limit + budget cap).
9. **CI** (GitHub Actions) running unit + browser tests on every PR; compiled (not CDN) Tailwind; SRI; CSP.
10. Service-worker **update flow** ("new version available — reload") so staff don't run stale code.

---

## 2. How it compares with existing tools (from general knowledge — verify)

| Capability | StoreVision v2 | Sortly / inFlow / Zoho Inventory style apps | Odoo / ERP inventory | SAP itself (MI01/MI04/MI07 physical inventory, Fiori "count" apps, RF/handheld scanners) |
|---|---|---|---|---|
| Barcode scanning (decoded) | ✗ (LLM reads text) | ✓ | ✓ | ✓ (scanner guns) |
| Multi-user, roles, audit trail | ✗ | ✓ | ✓ | ✓ (strongest) |
| Offline with sync | partial | varies | varies | usually needs connectivity/RF |
| Import book stock & reconcile | ✗ | partial | ✓ | ✓ native |
| Serial / batch tracking | ✗ | ✓ | ✓ | ✓ |
| Cycle-count scheduling (ABC) | ✗ | limited | ✓ | ✓ (cycle counting indicator in material master) |
| Issue / return register | ✗ | basic | ✓ | ✓ (movement types, special stock) |
| **AI visual count of unbarcoded stacks** | ✓ | ✗ | ✗ | ✗ |
| Setup cost / lock-in | very low | subscription | high | already owned |
| Fit to *your* flow (SAP export → weekly count → shortage list) | partly | generic | heavy | heavy to use on shop floor |

**Honest read.** Commercial apps beat StoreVision on every *control* feature (roles, audit trail, serials, scanning).
StoreVision's only unique asset is AI stack counting. The sensible position is **not** to rebuild an ERP, but to be a
**thin, fast count-and-reconcile layer next to SAP**: SAP stays the book of record and posts adjustments; StoreVision
does counting, variance analysis, the issue/return register and weekly cycle-count management, and exports an
adjustment list for posting in SAP. If you need serial-level control of expensive sensors, SAP serial numbers or a
purchased tool may beat anything we build — worth a quick check with whoever administers your SAP.

---

## 3. Your requested features — design

### 3.1 SAP / Excel stock import (book stock)
- Upload `.xlsx` or `.csv` (browser-side parsing; SheetJS from a pinned CDN or vendored file).
- Column mapping screen (remember the mapping): **Material, Description, Plant, Storage Location, Batch, Unrestricted Qty,
  Blocked/QI Qty, UoM, Value or Moving-Average Price (MAP)**. Typical SAP sources: MB52 (stock per storage location),
  MMBE, or an ALV export from your own report. *(I need a sample file — see §6.)*
- **Normalisation** (the part that usually breaks reconciliation): trim, upper-case, strip/keep SAP leading zeros
  consistently, handle numeric materials turned into scientific notation by Excel, thousands separators, decimal commas.
- **Alias table**: supplier label part no ↔ SAP material (the label on the box often differs from the SAP code). Unknown
  labels go to a "resolve" queue instead of being silently dropped.
- Each import is a versioned **snapshot** (date, file name, row count, checksum). Reconciliation always references one snapshot.

### 3.2 Count vs SAP reconciliation
- **Blind counting**: counters never see the book quantity until they submit. Showing book qty makes people "count to the number".
- Per material (summed over bays): `Variance = Counted − Book`; classify **Match / Shortage / Excess / Not in SAP / Not counted**.
- Value impact = Variance × MAP. Tolerance bands (e.g. ±0 for sensitive, ±2% for fasteners) decide what needs action.
- Any variance outside tolerance → **mandatory recount by a second person** → then reason code
  (miscount, issued-not-posted, receipt-not-posted, damage, transfer, theft-suspected, unknown) → manager approval.
- Output: variance report (CSV/PDF), and an **adjustment proposal file** formatted for posting in SAP (MI04/MI07 style).
  The app **never posts to SAP**; posting stays with authorised SAP users (control + audit).
- Stock in the register (§3.3) is reconciled as its own bucket so it doesn't create false "excess".

### 3.3 Inward / Outward register (accident-repair issues and returns after inspection)
*(I'm assuming "RI" = returned/re-inspection and "accidental" = accident-repair jobs. Correct me.)*
- A **movement ledger**, append-only, each line: date/time, material, qty, serial/batch, **movement type**, reference
  (job card / claim / vehicle chassis / customer), issued-to, issued-by, approver, reason, condition, photo, notes.
- Movement types and status flow:

```
Store stock ──Issue──▶ ISSUED (open, with ageing clock)
ISSUED ──Return──▶ RETURNED–RI HOLD  (physically back, NOT saleable, NOT in free stock)
RI HOLD ──Inspect OK──▶ RESTOCK (approved by manager, returns to inventory)
RI HOLD ──Inspect fail──▶ SCRAP / RETURN-TO-VENDOR / CLAIM
ISSUED ──Consumed──▶ CLOSED (fitted on the vehicle)
```
- Returned parts live in a separately labelled physical area and a separate ledger bucket — exactly what you asked for.
- Dashboard: **open issues by age** (flag > N days), RI-hold list, items awaiting a decision, per-job view.
- Hard rule: nothing moves from RI-HOLD back to free stock without a manager approval event.

### 3.4 Store-manager access
Requires real accounts (§4). Proposed roles:

| Role | Can do |
|---|---|
| **Counter** | Count, see own entries, **no book qty, no prices** |
| **Store manager** | Run the register, approve restocks/variances, assign counts, see variances |
| **Owner/Admin** | Import SAP snapshots, manage users, tolerances, price classes, see values, export for SAP posting |

### 3.5 Weekly reconciliation as a routine
- **Weekly cycle-count plan generated automatically** from the latest SAP snapshot:
  A-items every week, B-items monthly, C-items quarterly (or A weekly + a rotating share of B/C so every bay is covered).
- A status board: planned / counted / recounting / variance / approved. Week is **locked** after manager sign-off.
- Weekly report: Inventory Record Accuracy (items matched ÷ items counted), net and gross variance value,
  top shortages, open register items, ageing. Trend week-over-week.
- Reminders (WhatsApp/email later) on Friday for uncounted A-items.

### 3.6 Price sensitivity & theft control
- **ABC by value** computed from SAP (qty × MAP): A ≈ top ~70–80% of value, B next ~15–20%, C rest. Plus a manual
  **"Sensitive"** flag (e.g. any sensor above ₹X unit price, or a named list) that overrides ABC.
- Controls scaled to class:
  - **Sensitive / A:** counted every week (or daily for the very top few), **serial-number level**, zero-variance tolerance,
    immediate escalation, secured/caged bin, two-person issue and return with photo.
  - **B:** monthly count, small tolerance. **C:** quarterly.
- **Blind counts and rotating counters** for sensitive items; the person who issues parts should not be the only person who counts them.
- Every movement of a sensitive part needs a reason and approver; the register shows an **exception list** (issued > N days,
  returned with different serial, repeated shortages on the same bay).
- Hide prices from counters. Photograph serial plates at receipt, issue and return.
- Be realistic: software shows *where and when* losses occur; physical controls (locked cage, access log, CCTV, gate pass)
  are what stop theft.

---

## 4. Architecture decision (the blocker for multi-user)

A store manager logging into a register means **one shared database with per-user logins**. `localStorage` and a
"shared token" Google Sheet cannot give per-user identity or audit trails.

| Option | Pros | Cons |
|---|---|---|
| **A. Supabase** (hosted Postgres + auth + row-level security + realtime) | Real users & roles, audit-friendly, offline queue possible, free tier to start, you can export everything | New account to manage; I must design schema/RLS carefully |
| B. Google Sheet + Apps Script | You already know Sheets; easy for managers to *view* | Shared token only, no per-user audit, quotas, fragile for concurrent edits |
| C. Firebase | Mature offline + auth | Proprietary; harder to query for reports |
| D. Self-hosted (small VPS / Postgres) | Full control | You carry the ops burden |

**Recommendation: A (Supabase) as the system of record, with Google Sheets as a read-only report export.**
Whichever you pick, keep the local outbox so counting works with poor warehouse signal.

---

## 5. Roadmap (build order — each step ships and is tested on its own)

1. **Hardening (no new features):** IndexedDB + persistent storage, draft autosave, global error handling, schema migrations,
   backup/restore, compiled Tailwind + SRI + CSP, CI, service-worker update prompt.
2. **Real barcode scanning** (BarcodeDetector where available, WASM/JS decoder fallback for iPhone) — LLM becomes optional OCR for description/MRP only.
3. **Backend + login + roles** (needs your storage decision).
4. **SAP import + reconciliation** (blind count → variance → recount → reason → approval → SAP adjustment export).
5. **Issue/Return register** with RI-hold bucket and ageing dashboard.
6. **Weekly cycle-count planner** + ABC/sensitive classification + weekly report.
7. **Accuracy benchmark for AI counts** on 30–50 of your real rack photos so we know when to trust it.

---

## 6. Information I need from you (shapes the build)
1. A **sample SAP/Excel stock export** (anonymise values if you like): which T-code/report, and the column headers.
2. Where should shared data live — Supabase (recommended), Google Sheet, or something you already use?
3. How many **users/devices** (counters, managers) and how many **SKUs** and **bays**?
4. Do you track **serial numbers** in SAP for the expensive sensors? What's the price threshold for "sensitive"?
5. Confirm the meaning of **RI** and **accidental** in your process, and who approves a restock.
6. Do **counters** need to be blocked from seeing book quantity and prices? (I recommend yes.)
7. Should the app ever write to SAP? (My strong advice: no — export an adjustment file for authorised posting.)


---

## 7. Findings from the sample SAP export (Bilaspur branch, structural facts only — no stock data is stored in this repo)
- The report is **lot-level**: one row per part per GRN lot (≈2,900 rows for ≈1,850 distinct part codes). Reconciliation must
  **sum rows per Part Code** before comparing with the physical count.
- Quantities: `Total Quantity` = Available + Reserved + Blocked and is the figure to compare against a physical count.
  `Issued Quantity` is a lot-history figure and must **not** be added. `In-Transit` is not physically in the store.
- `Part-Bin Location` (about 200 distinct values such as `C01-E4`, `D02-C2`, `17A`) corresponds to your bays. A few are empty or `0`
  and need a fallback. `Lot-Bin Location` (e.g. `BIN01`) is not a rack location.
- Units are mostly `EA`, with `KIT`, `SET`, `ST`, `L`, `M`, `KG`, `MM` — **fractional quantities exist**, so counts must allow decimals for those units.
- Part codes are text (e.g. `165462VE0A`); keep them as text so leading zeros and letters survive.
- Price sensitivity: using **unit Cost > ₹10,000** flags roughly 135 parts (≈46% of stock value); using **MRP > ₹10,000** flags roughly 270.
  The threshold basis (Cost vs MRP) will be a setting; Cost is the default because it is what a loss actually costs you.
- Material types seen: `ZSPD`, `ZLOC`, `ZCON` (consumables/lubricants). Lubricants count in litres.


---

## 8. Build status
- Done: hardening; Supabase foundation (branches, roles, audit); sign-in, Team and Branches screens; **SAP stock upload** (reader, safety checks, all-or-nothing import, blind-count permissions).
- Next: blind count lists and entry (counters) -> comparison and shortage/excess report -> recount and approval -> issue/return register -> weekly plan and report.
