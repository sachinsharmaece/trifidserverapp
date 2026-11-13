# LOCK-34 — Plan

Written 3 Nov 2026 from a read-only review of `trifidserverapp` and `trifidadminapp`
(the buyer/seller app needs no change: its registration runs through the server).
Branch: `feature/lock-34-dormant-pool` in both repos, from `feature/work-2026-11-03`.

## 1. Stack

Server: Express 5, Mongoose 8 (MongoDB replica set), Zod 4, Agenda 6 worker (EC2),
vitest + mongodb-memory-server. The server commits its built `dist/`.
Admin app: React 19, Vite, Tailwind, react-router, vitest + Testing Library.

## 2. Where each concept lives

| Spec concept           | Code                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Party                  | `Buyer` (+ `Counterparty` for firm, GSTIN, mobile). The call log points at `Buyer`.                                                                                                                                      |
| Call log               | `CallLog` — `buyerId`, `employeeId`, `at`, `kind` (`call`/`note`/`update_request`), `outcome`. The reasons are its outcomes less `placed_an_order`.                                                                      |
| Caller / Team Leader   | `Employee.positions`: `SALES_EXEC`, **new `SR_SALES_EXEC`**, `SALES_LEADER` (= Sales Team Leader).                                                                                                                       |
| Bill                   | `MargBill` with `state: 'matched'` (a `query` bill stops the chain). `valuePaise` is the GST-inclusive invoice total; `keyedAt` is the invoice date the keyer typed. Not `So.state`, which moves on to delivered/closed. |
| Money unit             | Paise (₹10,000 = 1,000,000).                                                                                                                                                                                             |
| Old owner field        | `BookAssignment` (one row per buyer; no row = Queue). Kept as a mirror written in the same transaction as the holding.                                                                                                   |
| Settings + change log  | `Config` key/value; `updateConfig` already writes who/when/from/to to `audit_log`.                                                                                                                                       |
| Scheduler              | Agenda worker (`worker/index.ts`), not Vercel cron.                                                                                                                                                                      |
| 4 working hours        | `addWorkingHours` (`shared/clock.ts`) — 09:30–19:00 Mon–Sat IST.                                                                                                                                                         |
| Buyers / Today screens | `SalesBuyersPage.tsx`, `SalesTodayPage.tsx`.                                                                                                                                                                             |
| Creation paths         | `registerBuyer` (buyer app and staff-assisted) and `registerBuyerByStaff` (also used by `import:buyerLeads`). No Meta / field-associate path exists.                                                                     |
| Placeholder data       | Not in the repos — loaded straight into the database. Helpers `isPlaceholderMobile` / `isPlaceholderTehsil`; range 9999999991 upward (confirm against the database before go-live).                                      |

## 3. Decisions taken with the client (3 Nov)

- New position **Sr. Sales Executive** (`SR_SALES_EXEC`): `sales` role, reports to a Sales Leader, counts as a caller.
- Meta / field-associate lead upload: **skipped** (marketing phase later).
- Net amount of a bill = invoice value. Refunds are not deducted (a part-rejection refund is raised before billing, so the bill is already net). Returned boxes: one seam, `returnedValuePaise()`, returns 0 until the accounting module gives return notes a value.
- A "Dormant policy" page is added under Manage (the Config table had an API but no screen).
- The nightly clock job runs only when the server env key `DORMANCY_JOB_ENABLED=true` **and** the admin switch is on.
- Pool cards come from a whitelisted DTO (name, tehsil, district, past holders). The buyer file stays protected only while `OWNERSHIP_SCOPE_ENFORCED=true`.
- Register / Approve forms are left as they are; with the switch on their "Assigned to" picker has no effect.

## 4. Files

**Server — created:** `models/Holding.ts`, `PoolReview.ts`, `MargBillImport.ts`; `modules/holding/*`
(rules, settings, bills, service, queries, job, controller, routes, validation); `shared/placeholders.ts`;
`scripts/lock34Common.ts`, `migrateOwners.ts`, `importMargBills.ts`, `importCallerLists.ts`;
`tests/holdingRules.test.ts`, `tests/holding.test.ts`; `docs/lock-34/*`.

**Server — modified (each a few lines, all inert with the switch off):**
`config/positions.ts` (+position), `models/Employee.ts` (+`receivingLeads`), `config/env.ts` (+job key),
`shared/team.ts` (Sr. exec in the side filter; `mayChangeOwner` false when on),
`shared/scopeReadiness.ts` (Sr. exec needs a leader), `shared/scopeRegistry.ts` (new GETs listed — an existing test requires it),
`modules/admin/admin.team.ts` + `admin.validation.ts` (position, `receivingLeads`, holdings move with the book rows on deactivation),
`modules/onboarding/buyer.registration.ts` + `onboarding.service.ts` (one `assignNewParty` call each; `setAssignment` skipped when on),
`modules/lead/lead.service.ts` (`moveLead` refused when on), `modules/desk/sales/sales.service.ts` (`ensureBookAssignment` skipped when on),
`modules/desk/sales/sales.buyers.ts` (adds `holding` to a row when on), `app.ts` (mount router),
`worker/index.ts` + `worker/agendaProducer.ts` (02:00 IST job), `package.json` (3 scripts), `dist/` (rebuilt in the last commit).

**Admin app — created:** `api/holding.ts`, `lib/useHoldingStatus.ts`, `components/holding/*` (Pool tab, Clocks group, wording helpers),
`desks/admin/DormantPolicyPage.tsx`, `tests/HoldingScreens.test.tsx`.

**Admin app — modified:** `SalesBuyersPage.tsx` (Queue → Pool, "Held as" column), `SalesTodayPage.tsx` (Clocks group),
`BuyerDetailsCard.tsx` + `SalesBuyerFilePage.tsx` ("No mobile"), `EmployeeForm.tsx` + `TeamPage.tsx` + `api/dto.ts` + `api/admin.ts`
(position, Receiving leads), `lib/validators.ts`, `App.tsx` + `AppShell.tsx` (route and menu entry), `api/sales.ts` (`holding` on a row).

## 5. Risks

- The 850 imported pending buyers become go-live leads; they cannot bill until approved and would all reach day 67 together. Approve them first, or keep the nightly job off until the client decides.
- The deployed develop server and a local server share one Atlas database, so the admin switch is shared. Do not run a local worker against it with the switch on.
- Turning the switch off after it was on leaves holdings in place while the old writers resume; treat "on" as one-way (REPORT has a reconcile note).
- A rejected, blacklisted or deleted firm is dropped from counts and the Pool, and its holding is closed quietly by the nightly job.

## 6. Baseline (before the change)

Server `tsc --noEmit`: clean. The server suite, lint and build, and the admin app's typecheck, lint, tests and build, are recorded in `REPORT.md`.
