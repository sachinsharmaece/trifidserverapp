# RECTIFY-01 — Plan to fix the flow audit (A) and build the requote (C)

**Version 1, 9 November 2026.** Basis: the flow audit of `trifidserverapp` and `trifidadminapp`
(branch `develop`, server beab3e3, admin 35ec3aa), read against Charter v2 and LOCK-21 to
LOCK-36. Section B of the audit is settled by **LOCK-36** (parked quote and rate change accepted;
the rest pending for the next overview).

Effort figures are the author's estimates in developer-days, tests included, for one developer
who knows the codebase. They have not been checked with the build team.

---

## 1. The order of work, and why

The order follows money at risk first, then customer-visible breakage, then friction.

| #   | Item                                                | What goes wrong today, in business terms                                                                                                                                                                       | Phase | Est. days |
| --- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --------- |
| P0  | Requote kill switch + data audit                    | A seller's requote tells every buyer "accept or cancel" with nothing to accept. The pile is closed and the buyers are stranded                                                                                 | 0     | 1.5       |
| A11 | Double-sold quote stock (new finding)               | An order from an ask does not reduce the quote's listing line, so the same boxes can be piled and confirmed by another buyer. Result: a shortfall, a refund, a seller strike for a sale he never double-booked | 1     | 2         |
| A1  | 30-day ask expiry never runs                        | Dead demand stays on the Purchase board forever; sellers keep quoting into it; Sales funnel counts are inflated                                                                                                | 1     | 1.5       |
| A2  | 24 h hold and 24 h binding not enforced             | A quote stays takeable for ever at a rate the seller gave days ago. He is not really bound for 24 h, he is bound for ever                                                                                      | 1     | 3         |
| A9  | Place of supply hard-coded intra-state              | Buyers outside Madhya Pradesh get a CGST+SGST split instead of IGST on the order. Wrong tax head on the invoice; GST return and buyer's input-credit mismatches. Totals are unaffected                         | 2     | 2.5       |
| A6  | A declared payment stops the cancel, with no limit  | A buyer can keep an unpaid order alive, and the seller's stock held, by declaring a payment that never arrives                                                                                                 | 2     | 1.5       |
| A7  | Cancelling an unpaid order does not free the seller | The hold only lapses by its clock; the boxes are not put back on the listing; the seller is not told                                                                                                           | 2     | 1.5       |
| C   | Requote buyer step (QR-045)                         | See §5                                                                                                                                                                                                         | 3     | 6         |
| A8  | Phantom-quote strike is manual                      | A seller who wins a quote and cannot supply is only struck if somebody remembers to record it                                                                                                                  | 3     | 1.5       |
| A5  | One receipt covers one order only                   | A dealer's single bank transfer for three orders must be split by hand into three receipts                                                                                                                     | 4     | 6         |
| A4  | PO per order vs one PO per hold                     | The seller gets one PO per buyer for what he sends as one truck                                                                                                                                                | 4     | 2         |
| A10 | Two delivery bands vs "2 or 4"                      | Document only                                                                                                                                                                                                  | 4     | 0.5       |
| A3  | Rate may rise on a Sales-approved change            | **Closed by LOCK-36.** Guard rails O3–O5 wait for the owner                                                                                                                                                    | —     | —         |
|     | **Total**                                           |                                                                                                                                                                                                                |       | **≈ 30**  |

Roughly six weeks for one developer, three to four for two. Phases 1 and 2 are independent and
can run in parallel.

---

## 2. Rules of the work

1. **One flag per behaviour change**, stored as a `Config` row the way `claim_board` is. Off in
   production until the data audit (§3) has been read. Rollback is the flag, not a deploy.
2. **Every job takes `now` as a parameter**, is idempotent, and processes a bounded batch. Copy
   `promotion-offer-expiry` (`modules/clocks`, `worker/agendaProducer.ts`).
3. **Money and stock writes are conditional updates inside a transaction** (the pattern
   `releaseOffer` already uses), so a buyer accepting and a clock expiring at the same instant
   cannot both win.
4. **One pull request per item.** No collateral edits, no refactors, no formatting passes.
5. **Each item ships with tests for the cases in its section**, including the clock boundaries.
6. **Docs move with the code.** §7 lists which document changes with which item.
7. **Anything seen and not on this list** goes to `REPORT.md`, not into the pull request.

---

## 3. Phase 0 — before any fix goes live (days 1–2)

**3.1 Kill switch on requote.** Add `Config.pile_requote_enabled`, default `false`. With it off,
the server refuses `requotePile` with "Requote is being rebuilt — decline or confirm instead",
and the two Admin buttons (`PileDecisionForm.tsx`, `EnquiryDetailPage.tsx`) are hidden. Remove
the flag when §5 ships. This stops new stranded piles today.

**3.2 Data audit (read-only script, `--dry-run` only).** One CSV per line, run on production:

| Check                                                                                    | Why                                                |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Asks `open` or `quoted` with `ttlAt` in the past                                         | Size of A1                                         |
| Quotes `live` with `bindingUntil` in the past                                            | What A2 will expire on day one. Sales must be told |
| Quotes `pending_sales` older than 24 h                                                   | Size of the parked-quote age problem (O1)          |
| Quote-born listing lines whose `qty` is more than the live quotes behind them can supply | Size of A11                                        |
| Orders whose buyer's GSTIN state code is not 23 and `placeOfSupply = intra_state`        | Size of A9                                         |
| Upcoming receipts `waiting` for more than 48 h                                           | Size of A6                                         |
| Piles with `decision = requoted` and still-open pile requests                            | The stranded buyers today. Sales calls each one    |

**3.3 Recon questions to answer from the code before the fix (30 minutes each):**

1. Can a seller withdraw or reprice a live quote, or its quote-born listing line, inside the 24 h
   binding? (A2 needs the answer.)
2. Does a duplicate-ask merge (BR-371) refresh `ttlAt`? (A1.)
3. Where does the existing listing-rate function live, and does it write rate history? (C.)
4. Does anything else expire a waiting `UpcomingReceipt`? (None was found in `clocks` or
   `worker`.) (A6.)
5. Who else calls `createSo` with a hard-coded place of supply? (A9. Found so far: below.)

---

## 4. The fixes

### A11 — Reserve quote stock once (Phase 1, 2 days) — needs LOCK-36 §36.4 O2

**Today.** `acceptAskFill` creates the order from the quote and never touches the quote's
listing line. The line is on the all-India market from the moment the quote is posted.

**Fix.**

1. In `acceptAskFill`, inside the order's transaction, take the order's boxes off the quote's
   listing line with one conditional update (`qty >= boxes`). If it fails, that quote is no
   longer available: refuse it with "this stock has just been taken" and leave the ask open.
2. When the order is cancelled unpaid (A7) or the quote is expired, put the boxes back.
3. Do the same arithmetic for the pile path only if the recon shows it does not already hold
   (BR-378 holds boxes off the line at offer time, so it should).

**Tests.** Two buyers racing for the last boxes (one wins, one is refused); order cancelled
returns the boxes; partial fill; quote with no listing line (older rows) is skipped safely.

**Flag.** `reserve_quote_stock`.

### A1 — Ask lapse job (Phase 1, 1.5 days)

**Fix.** New job `ask-lapse`, hourly. For each ask with `state ∈ {open, quoted}` and
`ttlAt <= now`, in a transaction: `state = lapsed`; its `pending_sales` and `live` quotes →
`expired`; sync the enquiry; audit-log as system. Orders already raised from partial fills are
not touched. The quote-born listing lines stay (they run their own 45 days).

**Decision D1.** Whether the buyer is told. Default: **no WhatsApp** (it spends his one message
for the week). The lapsed ask appears on the Sales desk in a "Lapsed, worth a call" list.

**Tests.** Boundary at exactly `ttlAt`; ask with a part-fill; ask with parked and live quotes;
second run changes nothing; enquiry status becomes `lapsed`.

**Flag.** `ask_lapse_enabled`.

### A2 — Enforce the binding and the hold (Phase 1, 3 days) — needs LOCK-36 §36.4 O1

**Meaning, decided here for the owner's yes (D2).** One clock decides whether a quote can be
taken: the quote's `bindingUntil` (24 h from the moment Sales gave it, LOCK-36 §36.2.4). When it
passes, the quote can no longer be taken from the ask. The buyer can still buy the same stock as
an ordinary listing at its current rate, because the quote-born line stays on the market.

**Fix.**

1. `acceptAskFill` and the rate-change request refuse a quote whose `bindingUntil` has passed
   (`QUOTE_NOT_BINDING`: "This rate has run out. The desk will confirm it again with the
   seller."). The rate-change path already checks it; make both use one helper.
2. New job `quote-binding-expiry`, every 5 minutes: `live` quotes past `bindingUntil` →
   `expired`. If the ask then has no live quote, it goes back to `open` and `holdExpiresAt` is
   cleared, so the next quote starts a new round. This is what the short-fill code already does.
3. Parked quotes older than `parked_quote_max_hours` (default 24, O1) → `expired`; Purchase gets
   a "re-confirm with the seller" item.
4. Sales gets a "Re-give" action that returns a quote to `pending_sales` after the seller has
   re-confirmed by phone (reuse the proxy quote call; no new screen).

**Day-one effect.** Whatever the audit shows as live and past binding will expire at once.
Enable at a quiet hour, after Sales has the list.

**Tests.** Take at `bindingUntil - 1 s` (works) and at `bindingUntil` (refused); job expires
exactly the right quotes; ask returns to `open`; a second quote after expiry starts a new hold;
parked quote expiry; rate change refused after expiry.

**Flags.** `enforce_quote_binding`, `parked_quote_max_hours`.

### A9 — Place of supply from the buyer (Phase 2, 2.5 days)

**Today.** `'intra_state'` is written in `demand.service.ts` (ask fill), `pileOffer.service.ts`
(pile order), and `pool.service.ts` (twice); `accounts.service.ts` falls back to it. The code
comment says it is "refined once the tax-jurisdiction lookup exists". Marg then splits tax by it
(`marg.service.ts`).

**Fix.**

1. One helper `resolvePlaceOfSupply(buyer, deliveryLocation)`: **intra-state** when the buyer's
   state is Madhya Pradesh (TriFid's invoicing state, from config), otherwise **inter-state**. The
   state comes from the first two digits of the buyer's GSTIN (23 = Madhya Pradesh); if he has
   none, from the delivery location's state.
2. If neither is known, **refuse to raise the order** with a plain sentence ("Add the buyer's
   GSTIN or state first"). Do not default.
3. Replace the four hard-coded sites. Leave `purchase.print.ts` alone: it works out the PO's
   place of supply from the seller's GSTIN, which is the right test for a purchase order.
4. Backfill report only (§3.2). Orders already raised are corrected by Accounts and the chartered
   accountant case by case; the build does not rewrite history.

**Why it ranks high.** TriFid sells pan-India. Every inter-state order raised today carries the
wrong tax head. The sum is right; the invoice is not.

**Tests.** MP buyer; Rajasthan buyer; buyer with no GSTIN and a delivery location; buyer with
neither (refused); total unchanged for the same line under both splits.

**Flag.** None needed; the change is a correction. Ship behind a normal release.

### A6 — Bound the declared-payment pause (Phase 2, 1.5 days)

**Today.** `cancelUnpaidSo` does not cancel while the buyer has a waiting claim made inside his
window, and nothing in `clocks` or `worker` expires a waiting claim.

**Decision D5 (the ruling the flow chart left open).** Default: a declared payment pauses the
cancel for **24 hours after the window ends**, once per order. If Accounts has not matched it by
then, the claim expires, the order cancels as unpaid, and the buyer is told. A buyer with two
expired or rejected claims in 90 days gets no pause.

**Fix.** `UpcomingReceipt.expiresAt`; job `claim-expiry` (hourly); `cancelUnpaidSo` treats an
expired claim as no claim; a conduct count for the 90-day rule; Accounts Today lists claims
older than 12 h.

**Tests.** Claim inside the window pauses; claim expires at the limit; second pause refused;
claim matched in time releases the PO.

**Flag.** `claim_pause_hours` (0 means no pause).

### A7 — Release the seller when an unpaid order cancels (Phase 2, 1.5 days)

**Fix.** In `cancelUnpaidSo`, inside its transaction: end the stock hold at once (not by its
clock); put the boxes back on the listing line (pile order: through the pile request; ask order:
the A11 reservation); queue a seller notice, "buyer lapsed, stock released", with no buyer
identity (Charter §9.5, the wall). Pool orders keep their existing staff-resolved path.

**Tests.** Pile order and ask order both return their boxes; the notice carries no buyer name;
a second run does nothing; a pool order is untouched.

### A8 — Automatic phantom-quote strike (Phase 3, 1.5 days)

**Today.** The conduct types `seller_won_quote_could_not_supply` and
`seller_stock_nil_after_acceptance` exist but are recorded only by hand.

**Fix.** A Purchase action "Seller cannot supply" on an order that has not dispatched. It
records `seller_won_quote_could_not_supply` when the order came from an ask, otherwise
`seller_stock_nil_after_acceptance`, then runs the existing promotion-or-refund path
(`transitionToSupplyFailed`). The grace window (BR-212) already lives inside `recordFailure`.
The desk can waive the strike with a logged reason, as with a lifeline.

**Tests.** Ask order and listing order each record the right type; promotion offered when a
replacement exists; full refund when not; waiver logged.

### A5 — Receipts that cover more than one order (Phase 4, 6 days) — money code, last

**Today.** QR-057: a receipt names exactly one order, because a receipt has one amount and no
split, and the posted-receipts sum counts the whole amount for every order it lists.

**Fix.**

1. `UpcomingReceipt.allocations[{ soId, amountPaise }]`. Sales picks the orders; the screen
   suggests oldest payment deadline first and Sales can edit it. Σ allocations ≤ receipt amount.
2. `getPostedReceiptsPaiseForSo` sums the allocation for that order. A receipt with no
   allocations (every existing one) counts its whole amount for its single order, so nothing
   already posted changes.
3. INV-01 stays as it is: a PO releases only when the order's allocated money is at least its
   total.
4. **Decision D6.** Excess over the allocations goes to the buyer's on-account balance (the
   ledger already exists). A part-covered order waits on its own clock; if the clock ends, it
   cancels and the part-paid amount is refunded to the originating account (Charter refund
   rule). Today any posted amount, even a part, blocks the auto-cancel; that line in
   `cancelUnpaidSo` must change in the same pull request or a part-paid order sticks for ever.
5. Parallel run for one week: Accounts keeps recording as before; the new allocation is
   compared with their entries daily.

**Tests.** Two-order transfer, exact; transfer short of the second order; transfer over; legacy
single-order receipt; allocation to another buyer's order refused (INV-14); concurrent posting;
refund path for a part-paid cancelled order.

**Flag.** `multi_order_receipts`. Accounts signs off before it goes live.

### A4 — One PO per order, shown as one lot (Phase 4, 2 days) — ruling D4

**Ruling for the owner.** Keep one order and one PO per buyer, as built: each order has its own
payment, its own clock and its own refund, and a PO per payer is the only way to keep those
apart. Update LOCK-33 §33.6 and the supplier mock, which say "one PO for the paid boxes".
**Build** the missing half: a `lotRef` on the PO (the pile or ask it came from) and a grouped
"lot" view on the Purchase Dispatch and Today screens, so the seller's several POs read as the one
truck he sends.

### A10 — Delivery bands (Phase 4, 0.5 days) — ruling D7

Keep two bands (`48h`, `2-5d`) for launch. Record it in the charter and close the open item.

---

## 5. C — Build the requote (Phase 3, 6 days)

### 5.1 What is broken

`requotePile` receives no rate. It marks the pile `requoted`, sends each buyer "Seller revised —
accept or cancel" and stops. The pile is then decided, so the seller cannot confirm it. The
buyers have nothing to accept. The enquiry sits at `requoted`, waiting on the buyer, for ever.
The Admin screens say so: "the buyer step is not built yet (QR-045)".

### 5.2 The idea

Since BR-378, every confirm already gives each buyer a 24-hour deal to take or walk away from.
**A requote is a confirm at a new rate.** Build it on that machinery. No second mechanism.

### 5.3 Rules (Charter §9.6, LOCK-08.8 to 08.11, LOCK-24)

1. The seller (or Purchase, on a call) gives the **new rate** and the boxes he can send, with
   the same expiry and batch gates as a confirm.
2. Each buyer on the pile gets a 24-hour deal at his **own new rate** (new seller net plus his
   tier margin) and may take it or walk away. **Nothing is charged until he takes it.**
3. Taking it raises his order and opens a **fresh 24-hour payment window**. Walking away, or the
   24 hours running out, puts his boxes back on the listing.
4. The requote is logged and scored on the seller's record. **No strike.**
5. The seller's new rate is bound for the 24 hours, as for a confirm (`sellerLockedUntil`).

### 5.4 Build — server

1. `requotePile(sellerId, pileId, { newSellerNetPaise, canSendBoxes, expiryExact?, batch? })`.
   Validate: whole paise, more than zero, different from the line's current rate ("just
   confirm"). Same relaxed gates as confirm on the staff path.
2. In one transaction: `pile.decision = requoted`, `pile.requotedNetPaise`,
   `pile.requotedFromNetPaise`, `confirmedQty`, `sellerLockedUntil`; update the listing line's
   rate through the **existing listing-rate function** so rate history and price-band rules
   apply (D8, default yes); schedule the same fan-out job with the same 5-second undo.
3. `PileRequest` gains `offerNetPaise`, `offerFromNetPaise`, `requoted`. `offerPileRequests`
   writes them and sends `seller_requoted` (CH §21.8 #7) instead of `rate_ready`, carrying the
   request id and the buyer's new rate.
4. `acceptPileOffer` prices at `request.offerNetPaise ?? line.ratePaise`.
5. **`requestPileOfferChange` (BR-379) must floor at the deal's net, not the line's.** Today it
   uses `line.ratePaise`; after a requote that would allow an order below the new net.
6. `derivePileRequestStatus`: a requoted deal still `offered` is `requoted`, waiting on the
   buyer; `ordered`, `declined` and `expired` close the enquiry as they do for a confirm.
7. Seller scorecard: keep `requoteCount`; add what became of them (taken, walked away, ran out),
   so Purchase sees whether a seller's requotes convert.
8. **Bait-and-switch flag.** A requote that raises the rate by more than 25%, or a third requote
   by one seller in 30 days, is marked for the Purchase Leader on the seller's file. It is not
   blocked. Config `requote_review_pct`.

### 5.5 Build — Admin app

1. `PileDecisionForm` Requote: new-rate field (₹ per unit, tax-inclusive, ex-Indore), boxes and
   expiry as for Confirm. Same on the Enquiry detail page.
2. Sales buyer file and Enquiry detail: "Seller revised: was ₹X, now ₹Y. Waiting on the buyer,
   22 h left", with the existing on-behalf Accept / Walk away (`PileOfferActions`).
3. Sales Today: requoted deals with under 6 hours left.
4. Remove the "not built yet (QR-045)" text in `enquiryLabels.ts`.

### 5.6 Build — outside these two repos

1. **Buyer app** (not in the audited repositories): the pile-offer card shows the old rate struck
   through, the new rate, boxes and a countdown, with Accept and Walk away. The API adds
   `requoted` and `previousRatePaise` to `listMyPileOffers`.
2. **WhatsApp template.** `seller_requoted` changes its parameters; submit it for approval on day
   one of the phase (the status poll is BR-295). Until it is approved Sales phones each buyer;
   the Sales Today item above is the call list.
3. **Weekly cap (D9).** The one-message-a-week rule (BR-283) would swallow a requote notice. It
   is money-relevant, so treat it as `payment_due` is treated: it goes through.

### 5.7 Edge cases to test

| Case                                                         | Expected                                                                           |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Pile of 10, 20 and 30 boxes; seller can send 40              | Shortfall path as for a confirm; Sales divides                                     |
| Requote lower than the old rate                              | Same flow; buyers see the cut                                                      |
| Buyer A takes it, B walks away, C does nothing               | A: order at the new rate with a fresh 24 h window; B and C: boxes back on the line |
| Buyer takes it at the 24-hour boundary while the clock fires | Exactly one wins (conditional update)                                              |
| Sales rate change on a requoted deal                         | Floor is the new net; approval as in LOCK-36 §36.3                                 |
| Seller undoes within 5 seconds                               | No offers sent; pile open again                                                    |
| Requote on a decided pile                                    | Refused, `PILE_ALREADY_DECIDED`                                                    |
| Order raised from a requoted deal                            | `sellerNet` frozen at the new rate; PO ceiling (INV-07) holds                      |
| Listing rate after all buyers walk                           | Stays at the new rate (D8)                                                         |

**Acceptance.** The end-to-end test above passes, the enquiry closes in every branch, and no
pile is left in `requoted` with an open deal after 24 hours.

---

## 6. Rollout and checks

1. **Staging first**, on a copy of production data; run the §3.2 audit on it and compare.
2. **Order of switching on:** `reserve_quote_stock` → `ask_lapse_enabled` →
   `enforce_quote_binding` (after Sales has the list) → `claim_pause_hours` →
   `pile_requote_enabled` → `multi_order_receipts` (last, after the parallel week).
3. **Numbers to watch for four weeks** (a Monday summary):
   asks open past 30 days (target 0); live quotes past binding (target 0); listing lines
   promising more than is held (target 0); inter-state orders marked intra-state (target 0);
   claims waiting past the limit (target 0); requote → taken / walked / ran out; orders cancelled
   unpaid and how fast the seller was released.
4. **Rollback:** the flag. The data changes are additive columns, so no migration is undone.

---

## 7. Document changes that go with the work

| When      | Document                                        | Change                                                                                        |
| --------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Now       | `TriFid_Locked_Decisions_LOCK-36.md`            | Written. Owner to rule on O1–O5                                                               |
| A2        | Charter §9.3 clocks table                       | The hold and the binding both start when Sales gives the quote; one clock decides takeability |
| A6        | `purchase_flow.html`                            | "Does his claim pause the clock?" becomes ruled (D5)                                          |
| C         | Charter §9.6; ADMIN-CORE known defects          | Requote built; QR-045 closed                                                                  |
| A4        | LOCK-33 §33.6; `supplier_v4.html` HOLDS comment | PO per buyer order, shown as one lot                                                          |
| A5        | `docs/invariant-coverage.md` (server repo)      | INV-01 interim guard removed; QR-057 closed                                                   |
| A10       | Charter                                         | Two delivery bands recorded                                                                   |
| After all | `TriFid_Build_Charter_v2.md`                    | Fold LOCK-34, 35, 36 and this plan's rulings at the next clean re-issue                       |

---

## 8. Decisions needed from the owner

Each has a default, so the build is not held up. A "no" or a change on any of them changes the
section named.

| #   | Decision                                                                                    | Default                                                                 |
| --- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| D1  | Is the buyer messaged when his ask lapses?                                                  | No; Sales gets a recall list (A1)                                       |
| D2  | When a quote's 24 h ends, what is the buyer left with?                                      | The same stock as an ordinary listing; the ask returns to open (A2)     |
| D3  | LOCK-36 §36.4 O1–O5 (park limit, one reservation of stock, approver limits, monthly report) | Yes to all                                                              |
| D4  | One PO per buyer order, shown as one lot                                                    | Yes (A4)                                                                |
| D5  | A declared payment pauses the cancel for                                                    | 24 h after the window, once per order (A6)                              |
| D6  | Excess on a transfer; part-paid order at expiry                                             | Excess to the buyer's balance; part-paid order cancels and refunds (A5) |
| D7  | Delivery bands                                                                              | Two (A10)                                                               |
| D8  | A requote also changes the listing's rate                                                   | Yes (C)                                                                 |
| D9  | A requote notice goes through the weekly message cap                                        | Yes (C)                                                                 |

---

## 9. Not in this plan

- LOCK-36 §36.5: the Enquiry parent record, `expectedRatePaise`, head start, the chain-stage strip.
  They wait for the next overview.
- Not verified in the audit, so not planned: the promotion-offer cap logic against Charter parts
  12–14; the dock and movement modules; per-screen behaviour of the Admin app beyond the wall
  check and the forms read here. A second pass is worth doing after Phase 2.

---

_Confidential — TriFid Stores Pvt. Ltd. · RECTIFY-01 · plan to fix the flow audit._
