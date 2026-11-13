# RECTIFY-01 Build: stop-and-withdraw controls first, then the flow fixes

**Version 1, 9 November 2026. From: VP of Development. To: the developers' Claude Code.**
Implements `RECTIFY-01_PLAN.md` (the fixes and the requote build) after a new Phase 0 the
founder has required: **staff must be able to stop any listing and withdraw any seller quote.**

> **For Claude Code.** Save this file, `RECTIFY-01_PLAN.md` and `TriFid_Locked_Decisions_LOCK-36.md`
> in the repo under `docs/rectify-01/`, then run, in this order and as separate sessions:
>
> 1. Server repo (`trifidserverapp`, branch from `develop`):
>    `Read docs/rectify-01/RECTIFY-01_BUILD.md and execute Phase 0 (server) end to end. Stop at the Phase 0 review gate.`
> 2. Admin repo (`trifidadminapp`, branch from `develop`):
>    `Read docs/rectify-01/RECTIFY-01_BUILD.md and execute Phase 0 (admin) end to end. It needs docs/rectify-01/CONTRACT_CHANGES.md from the server run.`
> 3. After the founder clears the review gate, one session per later phase:
>    `Read docs/rectify-01/RECTIFY-01_BUILD.md and execute Phase <n>.`

---

## 0. Your role, and the rules above all others

You are a senior engineer fixing a working app that is in testing, with real sellers and Sales
and Purchase staff using it. You have two jobs, in this order: give staff a way to **stop
trading on a listing or a quote at once**, and then **correct the flow defects** found in the
9 November audit.

**The Buyer app is a separate repository and its team is fixing the database and the admin right
now.** It reads from this server and, we must assume, from the same database. Everything below
follows from that:

1. **Additive only.** No renamed or removed field, collection, route, enum value or error code.
   No changed response shape. New optional fields, new routes and new enum values that no
   existing screen can break on are allowed. New fields on stored documents carry a default so an
   old reader sees nothing new.
2. **Every change a buyer can see is behind a flag, off by default.** The Phase 0 controls are the
   exception, because they exist to be used now.
3. **Write every contract change down** in `docs/rectify-01/CONTRACT_CHANGES.md` as you make it:
   route or field, old, new, who reads it, flag. The Buyer app team gets this file.
4. **Do not touch the Buyer app or its repository.** Do not edit the database by hand. Scripts
   default to `--dry-run`, refuse any database that is not named in the test allow-list unless
   `--i-know-this-is-prod` is passed, and write a report CSV before they write anything.
5. **Add; do not rewrite.** No refactors, renames, reformatting, dependency upgrades, or "while I'm
   here" fixes. A defect outside this file goes in `REPORT.md` and the code stays as it is.
6. **Copy the codebase's own patterns**: module layout, Zod validation, `withTransaction`,
   `writeAuditLog`, `AppError` with `messageEn`, the permission constants (TD-007: permissions,
   never role names), the Idempotency-Key convention on every stage-moving POST, `notifyStaff`,
   the outbox, Agenda jobs in `modules/clocks` and `worker/agendaProducer.ts`. Read before you write.
7. **If the repo has a `CLAUDE.md`, read it first.** On code style it wins over this file; on
   business rules this file and the plan win.
8. **Track progress** in your task list, one item per section. The last item in every phase is
   checking your own work against the acceptance tests.

### 0.1 STOP conditions

On any of these, write the problem in `docs/rectify-01/PLAN_NOTES.md`, print one short question,
and stop. Do not guess.

- **S1.** A change would need a rename, a removal or a changed response shape (rule 1).
- **S2.** A step would write to production data outside an `--apply` script.
- **S3.** Stopping a listing meets a state the plan below does not cover (for example an open pool
  with paid commitments). Report it; do not cascade over it.
- **S4.** The baseline build is broken. Failing tests that are plainly unrelated are not a STOP:
  record them in `REPORT.md` and continue.

### 0.2 Facts already verified in the code (do not re-derive)

- Branch is `develop`; `main` is only the scaffold. Server: Node, Express, TypeScript, MongoDB
  (Mongoose), Agenda worker as a separate process. Money is integer paise.
- `Listing.state` is `live | paused | withdrawn`. The only writer to `paused` is the **seller's own**
  `pauseListing`, which flips the state and touches nothing else, and his `relistListing` flips it
  back. There is **no staff action** to stop a listing.
- `Quote.status` already contains `withdrawn` and the Admin type already knows it, but **nothing
  writes it**. There is **no way to withdraw a quote**, by staff or by the seller.
- A seller's quote is posted parked (`pending_sales`) and published as an all-India `quote_born`
  listing line at once; Sales gives it (`releaseQuote`) and it becomes `live` (LOCK-36 §36.2).
- The buyer feed and offers read listings with `state: 'live'`, so a paused listing leaves the feed
  with no Buyer-app change. Confirm that `createPileRequest` and `requireLineVisibleToBuyer` also
  refuse a non-live line before you rely on it.
- Buyer-facing notices and the weekly cap (BR-283) go through the outbox. Staff notices go through
  `notifyStaff`. The wall: Sales never sees a seller or his net; Purchase never sees a buyer.

---

## 1. Phase 0 (server): stop and withdraw

Estimate: 6 developer-days, tests included. Ships alone.

### 1.1 S1 — Stop a listing (staff)

`POST /staff/listings/:id/stop` and `POST /staff/listings/:id/restart`. Both need
`Idempotency-Key`. New permissions `LISTING_STOP` and `QUOTE_WITHDRAW`, granted by the existing
seed pattern to Purchase Leader and Admin (follow how `SALES_APPROVE_RATE_CHANGE` is granted).

**Request.** `{ reasonCode, note, confirm }`. `reasonCode` is a fixed dropdown, as BR-048 is:
`maintenance`, `stock_gone`, `rate_wrong`, `seller_request`, `compliance`, `other`. `note` is
required. With `confirm` false or absent the call writes nothing and returns the **impact
preview** (below). With `confirm: true` it acts.

**What it does, in one transaction.**

1. Listing → `paused` (the existing value; no new enum value), with `pausedAt`, and new optional
   fields `stoppedBy: 'staff'`, `stoppedByEmployeeId`, `stopReasonCode`, `stopNote`, `stopBatchId`.
2. **The seller cannot undo it.** His `relistListing` is refused for a staff-stopped listing:
   "TriFid has paused this listing. Call the purchase desk." Only `restart` lifts it, and it gives
   a fresh 45-day window as a seller relist does.
3. **Open piles** on its lines (no decision yet) are closed as a desk decline: `decision =
declined`, the enquiries synced, **no seller strike, the buyers not told** (LOCK-24.1 to .3),
   and Sales is notified with a list of the buyers to call (buyer names are fine for Sales; the
   seller's name is not).
4. **Deals already offered to buyers (BR-378) are left alone.** The seller confirmed them; they
   run to the end of their 24 hours. Orders already raised are untouched.
5. **Quote-born lines:** any `pending_sales` or `live` quote on the stopped listing is withdrawn
   as in §1.2, in the same transaction.
6. **Open pools with commitments:** do not cascade. Count them in the preview. If any exist, the
   stop is refused for a non-Admin, and for Admin it needs `confirmPools: true`. If a pool has
   paid commitments, **STOP S3**.
7. Audit log on the listing, one entry per cascaded change.

**Impact preview** (returned when `confirm` is not true): the listing, its lines and stock; counts
of open piles and boxes piled, offered deals still running, parked and live quotes, open pools,
and open orders that will not be touched.

### 1.2 S2 — Withdraw a quote (staff)

`POST /staff/quotes/:id/withdraw`, same permission pattern, same `{ reasonCode, note }`, same
preview-then-confirm.

**Allowed from** `pending_sales` and `live`. **Result:** `status = withdrawn`, with new optional
`withdrawnAt`, `withdrawnBy`, `withdrawReasonCode`, `withdrawNote`.

**In one transaction.**

1. If the quote was `live` and the ask has no other live quote, the ask goes back to `open` and
   `holdExpiresAt` is cleared, so the next quote starts a fresh round. This is what the short-fill
   code in `acceptAskFill` already does; reuse its logic, do not copy a variant.
2. Any open `RateChangeRequest` on the quote → `lapsed` (it already has that state).
3. **Its listing line:** if the line was created for this quote (`origin = quote_born`) and no
   other `pending_sales` or `live` quote points at it, stop the listing as in §1.1 step 1. If the
   line is the seller's own earlier line that the quote reused, **leave it alone**.
4. Orders already raised from the quote are untouched.
5. **No strike, no rank.** A withdrawn quote carries neither. The seller sees it as "withdrawn by
   TriFid" in his quote list; the existing status value does it.
6. If it was `live` (the buyer had been given the rate), Sales gets a staff notice: "A rate given
   to <buyer> has been withdrawn. Call him." No WhatsApp goes to the buyer: his weekly message is
   too valuable and the founder wants a call.
7. Sellers withdrawing their own quotes stays **refused**: a quote binds him for 24 hours
   (LOCK-08.7). Add no seller route.

### 1.3 S3 — The emergency controls

**Script: `scripts/stop-marketplace.ts`.** `--scope all | seller=<id> | product=<id>`,
`--reason <code>`, `--note "<text>"`, `--dry-run` (default), `--apply`. It stops every live
listing in scope and withdraws every parked or live quote in scope, using the same functions as
S1 and S2, tags the batch with one `stopBatchId`, and writes the report CSV first.

**Script: `scripts/restart-stopped.ts --batch <id>`.** Restarts **only** listings that batch
stopped and that are still staff-stopped. A listing the seller paused himself is never touched.
**Withdrawn quotes do not come back**; sellers re-quote and Sales re-gives. Say so in the script's
output.

**Flag: `Config.marketplace_paused`, default `false`.** When `true` the server refuses new
listings, new quotes, giving a parked quote, new pile requests and taking a quote or a deal, with
a new error code `MARKETPLACE_PAUSED` and plain English: "Trading is paused for a short while.
The desk will call you." One guard function, called at each entry point; list every entry point
in `PLAN_NOTES.md`. Add the code to `CONTRACT_CHANGES.md`, flagged **new error code, Buyer app
should show the message and not retry**. Orders already raised, payments, dispatch and Marg are
**not** paused.

### 1.4 The requote kill switch and the data audit

1. `Config.pile_requote_enabled`, default `false`. With it off the server refuses `requotePile`
   with "Requote is being rebuilt. Decline or confirm instead." (RECTIFY-01_PLAN §3.1).
2. The read-only audit script and its CSVs from RECTIFY-01_PLAN §3.2. `--dry-run` only; there is
   nothing to apply.
3. Answer the five recon questions in RECTIFY-01_PLAN §3.3 in `PLAN_NOTES.md`. One is already
   answered here: a seller **can** pause a quote-born listing during the binding, and the quote
   stays live; the plan's A2 must account for that.

### 1.5 Acceptance tests (server), all must pass

1. Stop with `confirm` absent returns the preview and writes nothing.
2. Stop sets `paused` and the staff fields; the buyer feed no longer lists the line; a new pile
   request on it is refused.
3. The seller's `relistListing` on a staff-stopped listing is refused; `restart` lifts it.
4. An open pile is declined with no strike; the buyers are not messaged; Sales is notified; the
   enquiries show `declined`.
5. An offered deal survives the stop and can still be taken inside its 24 hours; an order already
   raised is untouched.
6. Withdrawing a `live` quote returns the ask to `open` when it was the only one, clears
   `holdExpiresAt`, lapses its open rate-change request, and notifies Sales. Withdrawing one of
   two live quotes leaves the ask `quoted`.
7. Withdrawing a quote-born quote pauses its line; a quote that reused the seller's own line leaves
   that line live.
8. A second call changes nothing (idempotent). A caller without the permission gets 403.
9. `stop-marketplace --scope all` in dry-run writes nothing and the CSV matches what `--apply`
   then does; `restart-stopped --batch` restarts exactly that batch.
10. With `marketplace_paused` on, each entry point returns `MARKETPLACE_PAUSED`; with it off,
    behaviour is byte-for-byte the same as before.
11. Wall: no seller name in any Sales notice; no buyer name in any Purchase notice.
12. Existing tests pass with the flags off.

### 1.6 Phase 0 review gate (server)

Open the pull request against `develop`. Write `docs/rectify-01/REPORT.md` (template §5) and
`CONTRACT_CHANGES.md`. **Stop.** The founder reviews before anything is deployed; the Buyer app
team gets `CONTRACT_CHANGES.md` the same day.

---

## 2. Phase 0 (admin)

Estimate: 2 developer-days. Run after the server Phase 0 is merged to `develop`.

Use existing components and screens. **No new top-level screen.** Follow the patterns the
codebase uses for forms, pickers, toasts and the Idempotency-Key header.

1. **Stop listing** on the Purchase desk: a button on each listing row in the seller file and on
   the Stock page. It opens a dialog: reason dropdown, note, and the **impact preview** from the
   server, then Confirm. A staff-stopped listing shows "Stopped by TriFid, <reason>, <date>" and a
   **Restart** button.
2. **Withdraw quote** on each quote row on the Purchase Demand page, the seller file's open demand,
   and the Enquiry detail quotes table. Same dialog.
3. **Sales** sees the "rate withdrawn, call him" notice in its existing notices; the Rate-given
   panel shows a withdrawn quote as withdrawn and offers no Confirm.
4. **A paused banner** on every desk when `marketplace_paused` is on (read it from the existing
   config endpoint, or add one optional field to it).
5. Both buttons are hidden for staff without the permission.

Pitfalls found in this codebase before; check each: missing Idempotency-Key on a POST; raw IDs on
screen (names and pickers only); raw UTC timestamps (IST, DD/MM/YYYY); negative timers; amounts as
₹ with Indian grouping; validation messages at the field in plain words, never raw Zod text; number
inputs that append instead of replace.

---

## 3. Phases 1 to 4

Do not start until the founder has cleared the Phase 0 review gate and told you which phase. Each
phase is its own session and its own pull request per item.

| Phase | Items                                                                         | Source                    |
| ----- | ----------------------------------------------------------------------------- | ------------------------- |
| 1     | A11 reserve quote stock, A1 ask lapse job, A2 enforce binding and hold        | RECTIFY-01_PLAN §4        |
| 2     | A9 place of supply, A6 bound the claim pause, A7 release the seller on cancel | RECTIFY-01_PLAN §4        |
| 3     | C requote build, A8 automatic phantom-quote strike                            | RECTIFY-01_PLAN §4 and §5 |
| 4     | A5 receipts across orders, A4 PO lot view, A10 delivery-band note             | RECTIFY-01_PLAN §4        |

**Defaults.** Where the plan names a decision (D1 to D9), build the default. Where LOCK-36 §36.4
(O1 to O5) is NOT RULED, build it behind its flag and leave the flag off; the founder rules before
it is switched on.

**Changes in this file that override the plan:**

- Phase 0 above replaces the plan's Phase 0 and is larger.
- **A2 must now handle a seller-paused quote-born line.** A quote whose line the seller paused
  stays takeable through the ask; decide in `PLAN_NOTES.md` whether the expiry job should also
  expire it, and say why.
- **Anything that changes what a buyer sees** (A2 expiring quotes, A9 refusing an order with no
  state, A6 cancelling, C's new offer fields and the `seller_requoted` notice) ships with its flag
  **off**, and its entry in `CONTRACT_CHANGES.md` says what the Buyer app must handle first.
- The `seller_requoted` WhatsApp template needs Meta approval; submit it on the first day of
  Phase 3, as the plan says.

---

## 4. Allowed and forbidden changes

**Create:** the controls in §1 and §2, the scripts, the jobs and flags in the plan, tests,
`docs/rectify-01/*`.

**Modify, minimally and listed in `PLAN_NOTES.md` with exact lines:** the listing, quote, pile and
enquiry services the plan names; the permissions seed; the Admin pages named in §2 and in the plan;
the scheduler registration.

**Forbidden:**

- the Buyer app and its repository; the database by hand;
- renaming or removing anything the Buyer app may read (rule 1);
- pricing, the margin matrix, the order state machine and Marg keying, except where the plan names
  a line;
- auth; package upgrades (a new dependency needs a reason in `PLAN_NOTES.md`);
- enabling any flag in production;
- a seller-side route to withdraw a quote.

---

## 5. REPORT.md template

```
# RECTIFY-01 — Build report, phase <n>, <repo>
## Result         one paragraph: built, tested, flags and their state
## Files          created / modified, with line counts; must match PLAN_NOTES.md
## Contract       the entries added to CONTRACT_CHANGES.md
## Tests          the acceptance list above with pass / fail; full suite flags off and on
## Deviations     anything built differently, and why
## Skipped        items under STOP conditions, with the reason
## Out of scope   defects seen and left alone
## Switch-on      exact steps and order for the founder, each flag with the check to run first
```
