# Invariant coverage

**What this is.** Every invariant in `TriFid_PRD_v1.md` §6 (the invariant suite), mapped to the test
that proves it, so a gap is visible at a glance instead of needing a fresh audit each session.
Last audited: **20 September 2026, M9.** Paths are under `trifidserverapp/tests/`; the number after
the colon is the line of the `describe`/`it`.

**Reading the status column**

| Status         | Meaning                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| ✅             | Guard exists **and** has a failing-path test (the guard refuses; the test proves it refuses).                             |
| ✅ built in M9 | Was unguarded or untested before M9; the guard and/or its failing-path test were added.                                   |
| ⚠️ DEFECT      | The invariant is **violated today** and a test pins the defect as it stands. Needs a business rule — see the `QR-` named. |
| ⚠️ PARTIAL     | Guarded on one path; another path is open. Needs a business rule — see the `QR-` named.                                   |

**A note on numbering.** The M9 brief speaks of "`INV-01`–`INV-18` plus six added". The PRD lists
**26** invariants, numbered 1–26, and the code and SSOT already use `INV-nn` for exactly those
numbers. This document covers all 26. The "six added" are the wall and ownership groups (19–26).
`DATA_MODEL.md` §8's separate list of service-layer constraints is mapped in the second table.

---

## PRD §6 — the 26 invariants

### The process

| #   | Invariant                                                          | Status                            | Proof (failing path first)                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------ | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | No PO against an SO that is not paid in full                       | ⚠️ **DEFECT** (multi-SO receipts) | Single-SO: `chainM4.test.ts:249` (none posted · partial · second PO); concurrent payments `chainM4.test.ts:908`. **Hole:** one receipt allocated to two SOs releases both POs — `m9Invariants.test.ts:170` pins it as-is (turns red when fixed). `QR-057`. |
| 2   | No Marg billing before full payment                                | ✅ built in M9                    | `m9Invariants.test.ts:249` — an unpaid SO is refused and no `MargBill` row is created                                                                                                                                                                      |
| 3   | No Marg billing before leg 1 is complete                           | ✅ built in M9                    | `m9Invariants.test.ts:256` — a paid SO at `po_released` (no leg 1, no inspection) is refused                                                                                                                                                               |
| 4   | Nothing dispatches without a Marg invoice that agrees with the SO  | ✅                                | `chainM4.test.ts:348` (no bill · a query blocks); boundary `chainM4.test.ts:988`, `pricing.test.ts:215`                                                                                                                                                    |
| 5   | A queried Marg value books nothing to any ledger                   | ✅                                | `chainM4.test.ts:377` (₹90 off — nothing booked); `chainM4.test.ts:988` (₹5 vs ₹5.01)                                                                                                                                                                      |
| 6   | A failed PO carries a refund equal to what the buyer actually paid | ✅                                | `chainM4.test.ts:606` (whole-lot → full refund `= so.totalPaise`), `m6.test.ts:169`, part rejection `chainM4.test.ts:453`. Equal to "paid" because INV-01 gates the PO — subject to `QR-057`                                                               |
| 7   | A PO's rate never exceeds the SO's rate                            | ✅ built in M9                    | `m9Invariants.test.ts:211` — an edit above the SO rate is `409`; at/below is allowed. (`editPo` had **no** guard before M9.) Creation is safe by construction.                                                                                             |
| 8   | Quantities on a paired SO and PO match                             | ⚠️ **PARTIAL**                    | Guard exists but `createPo`'s call compares a value with itself; `editPo` allows a **PO-only quantity edit**. No test can assert it until the rule for pairing an edit exists — `QR-058`.                                                                  |

### The money

| #   | Invariant                                                          | Status         | Proof                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | Bank book closing balance equals the bank statement                | ✅ built in M9 | `m9Invariants.test.ts:401` — one paisa out is `409 DAY_CLOSE_OUT_OF_BALANCE` and writes no audit entry. Ten nil closes at month scale against an **independent** statement figure: `m9Perf.test.ts:236`. (`m7.test.ts:549` compares the book with itself — determinism only.) |
| 10  | Sum of buyer ledgers = matched Marg bills − receipts posted        | ✅ built in M9 | `m9Invariants.test.ts:356` — recomputed from raw rows, independently of `computeBuyerLedgerPaise`                                                                                                                                                                             |
| 11  | Sum of seller ledgers = bills booked − payments made               | ✅ built in M9 | `m9Invariants.test.ts:268` (seller ledger after a payout equals the independent recompute, and is 0)                                                                                                                                                                          |
| 12  | Debtors equal zero                                                 | ✅             | Holds: `chainM4.test.ts:235`, `m9Invariants.test.ts:356`. **Alarm fires:** `m9Invariants.test.ts:379` — a buyer billed without paying makes the total non-zero                                                                                                                |
| 13  | Every outward payment equals the seller's bill total on its PO     | ✅ built in M9 | `m9Invariants.test.ts:268` — a 22-of-25 part rejection pays exactly `acceptedValuePaise`, not the billed total                                                                                                                                                                |
| 14  | No receipt is allocated to another party's order                   | ✅ built in M9 | `m9Invariants.test.ts:118`, `:142` — cross-buyer, mixed, and unknown SO ids are refused; posting is refused too. (`allocateUpcomingReceipt` had **no** ownership check before M9.)                                                                                            |
| 15  | Upcoming receipts appear in no bank line and no ledger             | ✅ built in M9 | `m9Invariants.test.ts:340` — a claim moves neither the book, the closing balance nor the buyer's ledger                                                                                                                                                                       |
| 16  | A batch is never releasable by the person who built it             | ✅             | `chainM4.test.ts:658`, `:712`; re-auth required at release `m9Invariants.test.ts:484`, `:495`                                                                                                                                                                                 |
| 17  | Nothing payable to a seller with an unverified bank change pending | ✅             | `chainM4.test.ts:773`                                                                                                                                                                                                                                                         |
| 18  | GST is exactly 18% of taxable, rounded, on every document          | ✅             | `pricing.test.ts:94` (taxable + tax re-sums exactly), `:109` (reverse-compute within a paisa), `:195`/`:204` (CGST+SGST / IGST re-sum)                                                                                                                                        |

### The wall

| #   | Invariant                                                         | Status         | Proof                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ----------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 19  | No supplier identity, rate or margin in Sales or the buyer app    | ✅ built in M9 | **Every GET route, real data:** `m9WallSweep.test.ts:331` (sales, buyer). Rules proven to fire on a planted violation: `m9WallSweepRules.test.ts:48`, `:76`. Earlier: `m5.test.ts:211`, `orders.test.ts:103`, `m6.test.ts:405`; buyer app `wallSweep.test.tsx:34`. **Known gap:** `QR-060` (registration list shows seller firms to Sales) — recorded, self-verifying. |
| 20  | No buyer identity, rate or margin in Purchase or the supplier app | ✅ built in M9 | `m9WallSweep.test.ts:331` (purchase, seller); rules `m9WallSweepRules.test.ts:33`, `:76`. Earlier: `orders.test.ts:115`, `m6.test.ts:392`; buyer app `wallSweep.test.tsx:62`. **Known gap:** `QR-060`.                                                                                                                                                                 |
| 21  | No rate is rendered anywhere without its complete condition set   | ✅             | Buyer app `ConditionChips.test.tsx:26`, `:72`; server never sends `expiryExact` before confirmation `m5.test.ts:241`                                                                                                                                                                                                                                                   |
| 22  | The MSP surface contains no floor, no limit and no margin         | ✅             | `m6.test.ts:414`                                                                                                                                                                                                                                                                                                                                                       |

The Logistics rule (no firm, no money — `BR-071`) has no PRD number; it is swept by
`m9WallSweep.test.ts:331` (logistics) with rules at `m9WallSweepRules.test.ts:58`.

### Ownership and access

| #   | Invariant                                                                   | Status         | Proof                                                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 23  | Every classified account has exactly one owner                              | ✅ built in M9 | `m9Invariants.test.ts:426` — a second assignment never adds an owner and never answers 500; `:446` — a lane cannot take a second holder (unique index, proven). Assignment: `bookAssignment.test.ts:14`. |
| 24  | No account is unowned, including through a chained absence                  | ✅             | `absenceCoverChain.test.ts:28` (two-deep chain), `:69` (last person cannot go absent), `:89` (loop refused)                                                                                              |
| 25  | Only the Controller can repost a bank line                                  | ✅ built in M9 | `m9Invariants.test.ts:462` — Accounts, Sales and Purchase get `403` **even holding a valid re-auth token**; no re-auth `chainM4.test.ts:887`; happy path `:835`                                          |
| 26  | Only quantity and rate are editable on an SO or PO, and never after billing | ✅ built in M9 | `m9Invariants.test.ts:225` — other fields and unknown fields are `400`; a billed PO is `409`. SO after Marg: `chainM4.test.ts:543`                                                                       |

---

## `DATA_MODEL.md` §8 — constraints enforced in the service layer

| Constraint                                                                                                  | Status         | Proof                                                                                                |
| ----------------------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| A base unit cannot change on an SKU (`BR-055`); `baseUnitsPerBox` by the import rule or the row is rejected | ✅             | `skuImport.test.ts:68`, `:39`, `:48`                                                                 |
| Exactly one PO per SO, ever (`Q4`)                                                                          | ✅             | `chainM4.test.ts:278`, concurrent `:961`                                                             |
| The Marg tolerance is ₹5, no override for any role (`BR-033`)                                               | ✅             | `chainM4.test.ts:988`, `pricing.test.ts:215`; the route has no override field (`marg.validation.ts`) |
| Exactly one _matched_ Marg bill per SO, never consolidated (`DEC-038`)                                      | ✅             | `chainM4.test.ts:1122`                                                                               |
| A part rejection pays accepted quantity only; whole-lot → `supply_failed` (`DEC-030`)                       | ✅             | `chainM4.test.ts:453`, `:606`                                                                        |
| A negative-margin line is impossible by construction (`BR-021`)                                             | ✅             | `pricing.test.ts:71`                                                                                 |
| Seller blocks capped at 20 (`BR-089`)                                                                       | ✅             | `exclusion.test.ts:29`                                                                               |
| Exactly one holder per lane; the last active person cannot go away (`BR-262`, `BR-264`)                     | ✅             | unique index proven in `m9Invariants.test.ts:446`; `absenceCoverChain.test.ts:69`                    |
| No name on the `CH §23.5` dead list appears in any schema (`TD-012`)                                        | ✅             | `check:dead-list`, first step of `npm test`. Planted violation proven red and reverted in M9         |
| `Idempotency-Key` on every money/stage-moving POST; same key + different body refused                       | ✅             | `chainM4.test.ts:1045`, `:1063`, `:1093`                                                             |
| **Pool short close refunds those who paid, and only them** (`BR-158`, `QR-056`)                             | ✅ built in M9 | `m5.test.ts:475` (paid buyer refunded, unpaid buyer none), `:545` (nobody paid → no refund)          |

---

## Concurrency (`CH §25.6`)

| Race                                              | Status                                                                         | Proof                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------- |
| Two payments against one SO                       | ✅ (M4)                                                                        | `chainM4.test.ts:908`       |
| One PO from one paid SO, twice                    | ✅ (M4)                                                                        | `chainM4.test.ts:961`       |
| Two pool commitments crossing 75% together        | ✅ **fixed in M9** — was a real double re-confirm request                      | `m9Concurrency.test.ts:54`  |
| Two binding commitments crossing the MOQ together | ✅ **fixed in M9** — planted guard removal proved the test red (duplicate SOs) | `m9Concurrency.test.ts:90`  |
| Two claim-board claims on one pile                | ✅ (already correct — partial unique index)                                    | `m9Concurrency.test.ts:124` |
| Two bulk lifelines at once                        | ✅ **fixed in M9** — was a 96h extension for two 24h lifelines                 | `m9Concurrency.test.ts:211` |
| Bulk lifeline vs a dispatch-clock **expiry job**  | ⛔ not testable: **no such job exists** in the codebase                        | see the M9 CHANGELOG entry  |

---

## Wall sweeps (`ARCHITECTURE.md` §6.4)

| Sweep                                                                             | Where                                                                  | Proven to fail on a plant                                                                                                                                                            |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Purchase · Sales · Logistics · Buyer · Seller, **every GET route, real data**     | `m9WallSweep.test.ts:331`                                              | rules: `m9WallSweepRules.test.ts`; **live**: a seller id planted in the Sales chain view and a money field in the Logistics chain view both turned the sweep red, then were reverted |
| The Accounts-widening boundary (no restricted response names both counterparties) | dynamic: rule in every sweep above · static: `m9Boundaries.test.ts:74` | `m9WallSweepRules.test.ts:87`, `m9Boundaries.test.ts:95`                                                                                                                             |
| Notification log — no unmasked mobile, at rest or on read                         | `m9Boundaries.test.ts:109`                                             | schema check + value check on the raw number                                                                                                                                         |
| Founder — owns no query, cannot drift from Controller's or the owners' numbers    | `m9Boundaries.test.ts:158`                                             | import/query scan of every file in the module; overview compared with the owning functions called directly                                                                           |
| Seller town sweep                                                                 | `wallSweepTerritory.test.ts:18`                                        | (M3)                                                                                                                                                                                 |
| Condition-set · MSP                                                               | buyer app `ConditionChips.test.tsx`; `m6.test.ts:414`                  | (M5/M6)                                                                                                                                                                              |

**A sweep over an empty list proves nothing.** The first M9 run passed on an empty database and the
same sweep failed once other suites had left data behind: the Sales worklist leaked buyer ids to
Purchase and Logistics only when it had rows. The sweep world now seeds an unpaid order so that list
is never empty; when you add a desk list, add the row that fills it.
