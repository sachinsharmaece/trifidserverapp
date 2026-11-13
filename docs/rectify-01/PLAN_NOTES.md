# RECTIFY-01 — Plan notes, Phase 0 (server)

Branch `feature/rectify-01-phase0-stop-withdraw`, from `develop` at a0d4c07 (which carries
`pile-fanout-recovery` and, with it, `gst-inclusive-rates`; both confirmed merged before starting).
`LOCK-36` was not in the folder I was given, so nothing here leans on its text; where the brief cites it
the brief's own words were used. (The reviewer says it is `claude/TriFid_Locked_Decisions_LOCK-36.md` in
their project and that Rajat will copy it into this folder; nothing in Phase 0 depends on it.) No STOP
condition was hit (S1–S4): nothing is renamed or removed, no production data was touched, the baseline
built, and the one uncovered state (an open pool with paid commitments) is held behind an Admin-only
double confirm rather than cascaded over — see §2.

**Review round 1 (9 Nov).** The client's Claude reviewed commit `2ad2fa2` and found five defects; this
file describes the branch after they were fixed, one commit per item F1–F6 (hashes in `REPORT.md`). What
changed, and why, is marked "review 1" where it matters, and §6 records the answers to the six questions I
asked.

## 1. Where this departs from the brief, and why

1. **Script names and places.** The brief says `scripts/stop-marketplace.ts` and
   `scripts/restart-stopped.ts`. This repo keeps scripts in `src/scripts/` as camelCase with an npm alias,
   so they are `src/scripts/stopMarketplace.ts` (`npm run stop:marketplace`) and
   `src/scripts/restartStopped.ts` (`npm run restart:stopped`); the audit is `npm run audit:rectify01`.
   Same flags as the brief (`--scope`, `--reason`, `--note`, `--dry-run` default, `--apply`, `--batch`).
2. **The database rule applies to every run, dry or not.** "Refuse any database not named in the test
   allow-list unless `--i-know-this-is-prod`" is applied before connecting, so even a dry run against the
   shared Atlas needs the flag. The allow-list is `trifid_test` (the suite's in-memory database), in
   `src/shared/scriptSupport.ts`. A dry run also switches off Mongoose `autoIndex`/`autoCreate`, as
   `purgeDemoProducts` does, so it creates not even an index.
3. **Extra flags on the stop script:** `--confirm-pools` and `--confirm-paid-pools` (the script's
   equivalents of the route's `confirmPools` and `confirmPaidPools`; it refuses to run without the first when
   a listing it would stop has a pool its seller supplies with commitments, and without the second when a
   commitment in that pool is paid), and `--by <email or id>` / `--out <folder>` (who the audit entries
   name — default the first active Admin — and where the CSVs go — default `trifid data/rectify-01/`, as
   the purge script's backups do). A listing the run does not stop is a **skip**: it is printed by id, seller
   and product, marked in the CSV, and the command exits non-zero (review 1).
4. **`GET /staff/notices` carries the banner flags.** The brief says "read it from the existing config
   endpoint, or add one optional field to it". `GET /admin/config` needs `config:read`, which Sales and
   Purchase do not hold, so instead two optional booleans (`marketplacePaused`, `pileRequoteEnabled`) ride on
   the bell's call that every desk already makes on a timer. (`pileRequoteEnabled` is there so the admin
   session can hide the two Requote buttons, as RECTIFY-01_PLAN §3.1 says; BUILD §2 does not list that.)
5. **One small extraction in `acceptAskFill`.** The brief says to reuse the short-fill code that returns an
   ask to `open`, "do not copy a variant". Reuse needed it to be a function, so those five lines became
   `settleAskAfterQuoteLeaves` in `demand.service.ts` and `acceptAskFill` calls it. Same statements, same
   order, same transaction; both callers now share it.
6. **`Pile.deskDeclined` (new, default false) and a 3-line change in `listing.groups.ts`.** Not in the
   brief, but without it a restart would not restart anything: stopping declines the open piles, and
   `closedStateOf` reads "the latest group was declined" as "the seller said no" and keeps the line shut
   (`PILE_ALREADY_DECIDED`, "The seller declined this offer"). A group the desk closed on a stop is now
   ignored there. Groups a seller declines are unaffected. Test: "restart lifts it".
7. **The stop's pile decline writes no `proxyLog` entry.** The audit log carries one entry per cascaded
   change (listing, each pile, each quote, the ask when it reopens, each rate-change request lapsed).

## 2. Decisions the brief left to me

- **Who counts as Admin for `confirmPools`:** the holder of `seller:admin` (only Admin has it; TD-007 —
  permissions, never role names). `mayDecideRateChange` uses `buyer:admin` the same way for the Sales side.
- **"Open pools on a listing" (rewritten in review 1):** a pool belongs to a pack and a condition set, not to
  one seller (BR-151), and its supplier is recomputed from every live listing on that pack (BR-152:
  `findCurrentSupplier`, now exported from `pool.service.ts`). So the preview **lists** every active pool the
  listing's pack + condition-set keys would feed (`pools.list`: id, pack, status, MOQ, commitments, paid
  commitments, boxes committed — counts only, no buyer), but only a pool **this listing's seller supplies right
  now** counts towards the gate (`suppliedByThisSeller`). A pool somebody else supplies never blocks a stop,
  and neither does one a `New`-tier seller would "supply" (BR-153: he cannot). In the first build every pool
  on the pack counted, so a compliance stop on seller A was refused because of an unrelated pool.
  The gate for a pool the seller supplies that somebody has committed to (and not withdrawn):
  - a non-Admin (the Purchase Leader) is refused — 403 `PERMISSION_DENIED`;
  - Admin needs `confirmPools` — 409 `CONFIRMATION_REQUIRED`, `error.field = confirmPools`;
  - if a commitment in it is **paid**, Admin also needs `confirmPaidPools` — a second tick, not a wall. A stop
    moves no money and the restart undoes it, so a brake nobody can pull is worse than one with a double
    confirm. The note is already required on every stop. On success the active Admins get a
    `pool_needs_settling` notice naming each pool by product and pack, with the boxes committed, the paid
    count and the pool id — never a buyer — so the desk can settle them.
    The pool itself, and every commitment, is never changed by a stop. The preview carries a `gate`
    (`{blocked, needsConfirm}`) so the dialog can disable Confirm for someone who cannot proceed, or show the
    ticks an Admin must give, before the call is made.
- **A quote withdrawal that pauses its line runs the full stop's pile closure (review 1).** The line born for
  the quote is paused as before, and now also: the buyers' open piles on it are declined (same write as a
  Stop — no strike, no message), and Sales is told whom to ring. Offered deals are left to run, as with a Stop.
  `willHappen.pilesDeclined` in the preview says how many; the result carries `pilesClosed`. A withdrawal that
  leaves the line live (the seller's own earlier line, or another open quote still on it) closes no pile.
- **A pile confirmed but not yet offered when the stop lands (review 1).** The stop leaves it alone;
  `runConfirmPileFanout` checks the listing first and, if staff stopped it, closes the pile as a desk decline
  and tells Sales instead of giving the buyers a deal. The recovery job reaches it through the same function.
  If the listing was restarted before the fan-out ran, the deals are given as usual.
- **`confirmPile` refuses a staff-stopped listing, whatever the flag says (review 1)** — from the seller and
  from Purchase on a call — and its decision is now written with `findOneAndUpdate({_id, decision: null})`, so
  a stop's decline that lands first is not overwritten (a lost race answers `PILE_ALREADY_DECIDED`).
- **Restart does not revive a line with no quote behind it (review 1).** A quote-born listing is restarted only
  while an open quote still points at it. Otherwise it is **skipped and reported as `seller re-quotes`**: the
  route answers 200 `{restarted: false, alreadyLive: false, skipped: "seller re-quotes"}`, and the batch
  restart lists it with that outcome in its CSV (not counted as a failure).
  Before this, restarting would have put an all-India line back on the board at the withdrawn rate for 45 days.
- **Quotes withdrawn with a listing:** every `pending_sales`/`live` quote whose `listingLineId` is one of the
  stopped listing's lines — including a quote that reused the seller's own line, because that stock is now
  off the board. (§1.2 step 3's "leave the seller's own line alone" is about withdrawing _one_ quote.)
  Quotes with no `listingLineId` (older rows) are withdrawn only by the scripts' scope or by hand.
- **Who hears (Sales):** for each buyer, his book owner and nobody else (changed in review 1; the first build
  also told the owner's Sales Leader); a buyer in the Queue or whose owner has left goes to the active Admins
  (the rate-change notices' fallback). Each person gets one notice listing only their own buyers, with boxes.
  The seller is never named; Purchase gets no notice. A test asserts no other staff member is notified.
- **Restart on a listing the seller paused:** refused ("the seller paused it, so he relists it himself").
  Restart on a live listing answers `alreadyLive: true`, changes nothing.
- **A staff stop on a listing the seller had already paused** is allowed and takes it out of his hands.
- **HTTP codes:** `MARKETPLACE_PAUSED` is 409 (a state refusal; 503 invites automatic retries, 423 is
  already the sign-in lockout). The pool refusals reuse `PERMISSION_DENIED` and `CONFIRMATION_REQUIRED`
  (already used for "confirm and send again") rather than adding codes.
- **A2 (Phase 1) — a seller-paused quote-born line.** Agreed with the reviewer: the expiry job decides on
  `bindingUntil` alone and never looks at the line's state. The seller is bound for 24 h (LOCK-08.7) and the
  buyer was _given_ the rate; his own pause of the line must not shorten that, so the quote stays takeable
  through the ask until the binding runs out, then expires like any other. The job must not un-pause the line.
  The reviewer's matching condition — `releaseQuote` (Sales giving a _parked_ quote) refuses, or warns, when
  the quote's line is paused, because a buyer could otherwise take a rate through his ask whose line is off
  the board — is **not built here**: it is not on the F1–F6 list, so it stays a Phase 1 item to be done with A2.

## 3. The entry points `marketplace_paused` guards

One function, `assertMarketplaceOpen()` in `src/modules/marketplace/marketplace.guard.ts`, called first in:

| Entry point         | File                                       | Reached by                                                                                        |
| ------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `createListing`     | `modules/listing/listing.service.ts`       | seller `POST /listings`; staff `POST /staff/proxy/seller/listings`; the listing a quote publishes |
| `postQuote`         | `modules/demand/demand.service.ts`         | seller `POST /asks/:id/quotes`; staff proxy quote; Sales' give-rate                               |
| `releaseQuote`      | `modules/demand/demand.service.ts`         | Sales giving a parked quote                                                                       |
| `giveRateOnAsk`     | `modules/desk/sales/sales.stageActions.ts` | Sales giving a rate from the board (guarded before it pins the ask to a pack)                     |
| `createPileRequest` | `modules/listing/listing.service.ts`       | buyer `POST /listings/lines/:id/inquire`; Sales on a call                                         |
| `acceptAskFill`     | `modules/demand/demand.service.ts`         | buyer `POST /asks/:id/accept`; Sales on a call                                                    |
| `acceptPileOffer`   | `modules/demand/pileOffer.service.ts`      | buyer `POST /pile-offers/:id/accept`; Sales on a call                                             |
| `confirmPile`       | `modules/demand/demand.service.ts`         | seller `POST /confirmations/:id/confirm`; Purchase on a call — added in review 1                  |
| `relistListing`     | `modules/listing/listing.service.ts`       | seller `POST /listings/:id/relist` — added in review 1                                            |
| `commitToPool`      | `modules/pool/pool.service.ts`             | buyer `POST /pools/:id/commit` — added in review 1                                                |

The first seven are the brief's list; the reviewer found three more doors that start or extend trade during
a pause — `confirmPile` (its fan-out gives buyers 24-hour deals), `relistListing` and `commitToPool` (a buyer
could commit and pay) — and asked for them to be shut. Not guarded, on purpose: raising an ask (`raiseAsk` —
a buyer saying what he wants starts no trade, and the desk calls him), a placement into a pool already
committed to, a buyer walking away from a deal, a seller declining or undoing a pile, a seller **pausing** his
own listing, and the expiry jobs. The fan-out is not guarded by the flag either (it finishes a trade the
seller already confirmed) but it does close a pile whose listing staff stopped (see §2).

**The clocks keep running during a pause.** The 24-hour deal and quote clocks are not frozen while accepting
is refused, so a long pause silently kills deals. Keep a pause short. Freezing the clocks is a later founder
decision, not built here.

## 4. Existing files modified (exact lines in this branch, after review 1)

| File                                           | Lines                                                         | Change                                                                                                                                                                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app.ts`                                   | 38, 96                                                        | import and mount `marketplaceRouter`                                                                                                                                                                                                                                          |
| `src/config/permissions.ts`                    | 141–144                                                       | `LISTING_STOP`, `QUOTE_WITHDRAW` (Admin gets them: `Object.values`)                                                                                                                                                                                                           |
| `src/config/positions.ts`                      | 48–53                                                         | both granted to `PURCHASE_LEADER`, the way `SALES_APPROVE_RATE_CHANGE` is to `SALES_LEADER`                                                                                                                                                                                   |
| `src/models/Listing.ts`                        | 11–24, 42–50                                                  | `STOP_REASON_CODES`; `stoppedBy`, `stoppedByEmployeeId`, `stopReasonCode`, `stopNote`, `stopBatchId`                                                                                                                                                                          |
| `src/models/Quote.ts`                          | 3, 61–66                                                      | `withdrawnAt`, `withdrawnBy`, `withdrawReasonCode`, `withdrawNote`                                                                                                                                                                                                            |
| `src/models/Pile.ts`                           | 40–43                                                         | `deskDeclined`                                                                                                                                                                                                                                                                |
| `src/models/StaffNotice.ts`                    | 22–26                                                         | kinds `listing_stopped`, `rate_withdrawn`, and (review 1) `pool_needs_settling`                                                                                                                                                                                               |
| `src/shared/errors.ts`                         | 88–90, 141                                                    | `MARKETPLACE_PAUSED` (409)                                                                                                                                                                                                                                                    |
| `src/modules/listing/listing.service.ts`       | 45–48, 51, 208, 405–410, 451, 471–476, 977                    | guard imports; `export` on `LISTING_LIFE_DAYS`; guard in `createListing` and `createPileRequest`; `relistListing` guarded and refuses a staff-stopped listing; optional `stoppedByTriFid` on `getMyListings` (review 1)                                                       |
| `src/modules/listing/listing.groups.ts`        | 21–22, 36–40, 57, 65, 84                                      | `deskDeclined` ignored when reading a line's latest group                                                                                                                                                                                                                     |
| `src/modules/demand/demand.service.ts`         | 38–42, 359, 405, 486, 712, 791, 946, 963, 986–1005, 1068–1073 | guard imports; `settleAskAfterQuoteLeaves` (extracted) and its call in `acceptAskFill`; guards in `acceptAskFill`, `postQuote`, `releaseQuote`, `confirmPile`; `confirmPile` refuses a staff-stopped listing and writes its decision conditionally; `requotePile` kill switch |
| `src/modules/demand/pileFanout.job.ts`         | 11–14, 48–66                                                  | review 1 — closes a confirmed, not-yet-offered pile as a desk decline when staff stopped its listing                                                                                                                                                                          |
| `src/modules/demand/pileOffer.service.ts`      | 19, 194                                                       | guard import and call in `acceptPileOffer`                                                                                                                                                                                                                                    |
| `src/modules/pool/pool.service.ts`             | 28, 138, 179                                                  | review 1 — `export` on `findCurrentSupplier`; guard in `commitToPool`                                                                                                                                                                                                         |
| `src/modules/desk/sales/sales.stageActions.ts` | 26, 59                                                        | guard import and call in `giveRateOnAsk`                                                                                                                                                                                                                                      |
| `src/modules/notice/notice.routes.ts`          | 5, 24–32                                                      | `GET /staff/notices` also returns the two flags                                                                                                                                                                                                                               |
| `package.json`                                 | scripts                                                       | `stop:marketplace`, `restart:stopped`, `audit:rectify01`                                                                                                                                                                                                                      |

Two existing tests changed, because they exercise requote itself and requote is now refused unless
`pile_requote_enabled` is on: `tests/m8.test.ts` ("requoting a pile queues seller_requoted…", the one call
at the requote line) and `tests/optionalCallNote.test.ts` ("requotes and declines with no note", the
requote call). Each now wraps just that call in `withPileRequoteEnabled(...)` (new `tests/requoteFlag.ts`),
which turns the flag on for the length of the call and puts it back. Nothing else in either file changed.

New: `src/modules/marketplace/` (`guard`, `service`, `bulk`, `audit`, `controller`, `routes`, `validation`,
and — review 1 — `closure`: the pile-closing and Sales-notice helpers, split out so the fan-out job can use
them without importing the service back), `src/shared/scriptSupport.ts`, `src/scripts/{stopMarketplace,restartStopped,auditRectify01}.ts`,
`tests/rectify01Phase0.test.ts`, `tests/requoteFlag.ts`, `docs/rectify-01/*`.

No new dependency. The Buyer app and its repository were not touched; no database was edited by hand.

## 5. The five recon questions (RECTIFY-01_PLAN §3.3)

1. **Can a seller withdraw or reprice a live quote, or its quote-born line, inside the 24 h binding?**
   - _Withdraw a quote:_ no. The only seller routes on quotes are `POST /asks/:id/quotes` and `GET /quotes`;
     nothing a seller can call writes a quote after it is posted.
   - _Pause the quote-born listing:_ **yes** — `POST /listings/:id/pause` has no check on origin or on quotes.
     The quote stays `live` and stays takeable through the ask; `acceptAskFill` never looks at the line.
   - _Reprice the line:_ **yes, and the brief did not mention it** — `PATCH /listings/lines/:id/rate` works on a
     quote-born line too. The quote keeps its own `ratePaiseForIndore` (an order from the ask uses that), but
     the board now shows a different rate for the same stock. A cut beyond 2% needs the seller's double
     confirm (BR-109). A2 should not treat a repriced line as a repriced quote.
   - A2's answer is in §2 above.
2. **Does a duplicate-ask merge (BR-371) refresh `ttlAt`?** No. The merge is `findOneAndUpdate({… state:
'open' …}, {$inc: {qty}})`; `ttlAt`, `holdExpiresAt` and `visibleToAllAt` are untouched, so an ask that keeps
   being topped up still lapses 30 days after it was first raised. A _quoted_ ask is never merged into. (Note:
   a parked quote does not flip the ask to `quoted`, so boxes can still be merged into an ask that already has
   a parked quote behind it.)
3. **Where is the listing-rate function, and does it write rate history?** `changeListingLineRate` in
   `modules/listing/listing.service.ts` (seller-keyed: it finds the `Seller` by counterparty and the listing by
   `sellerId`). It sets `line.ratePaise`, bumps `line.version`, and writes **one `audit_log` row**
   (`listing_line`, field `ratePaise`, old → new). There is no rate-history collection; history is those audit
   rows plus `version`. For C: it also enforces BR-109 (a cut beyond 2% throws `DOUBLE_CONFIRM_REQUIRED`
   unless `doubleConfirmed`, and then flags `heldOutOfBenchmark`), so a requote that cuts the rate would need
   either that flag or a staff-callable variant that skips the seller-only lookup.
4. **Does anything else expire a waiting `UpcomingReceipt`?** No. The only writers are
   `allocateUpcomingReceipt` (sets `soIds`/`pickedBy`) and `postBankCredit` (sets `state: 'cleared'`), both in
   `payment.service.ts`. Nothing in `modules/clocks` or `worker/` touches it, and `cancelUnpaidSo` skips an
   order with a waiting claim (QR-065), so a claim never lapses. (`landed_wrong_account` is in the enum but
   has no writer either.)
5. **Who else calls `createSo` with a hard-coded place of supply?** Four hard-coded `'intra_state'` sites:
   `demand.service.ts` (`acceptAskFill`), `pileOffer.service.ts` (`raiseOrderForRequest`), and
   `pool.service.ts` twice (lines ~238 and ~361). `accounts.service.ts:368` falls back to it
   (`so?.placeOfSupply ?? 'intra_state'`). Also: the staff `createSo` route takes `placeOfSupply` from the
   caller's body (`chain.validation.ts:11`), so that path is only as right as the person who typed it.
   Everything downstream (`dock`, `marg`, `chain` PO/bill code) reads `so.placeOfSupply` and is correct once
   the order is. `purchase.print.ts` works from the seller's GSTIN and is left alone, as the plan says.

## 6. Questions raised in the first build, and how the review answered them

All answered by the client's Claude in review 1; each is built as follows.

1. **Pool with a paid commitment (S3) — refuse outright, or let Admin override?** Admin can, behind a double
   confirm; and only a pool the stopped listing's seller _supplies_ counts. Built: §2, "Open pools on a
   listing".
2. **Should a quote withdrawal that pauses its line run the full stop?** Yes — the buyers' open piles on the
   line were stranded open and the fan-out could then have given them deals at the withdrawn rate. Built: §2.
3. **Should the seller app be told a listing was stopped by TriFid?** Yes. `GET /listings/mine` items carry an
   optional `stoppedByTriFid: true`, omitted otherwise, so the app can hide Relist and say "Paused by TriFid —
   call the desk". No reason or note is ever sent to the seller. Built: `getMyListings`.
4. **`LOCK-36`** is in the client's project as `claude/TriFid_Locked_Decisions_LOCK-36.md`; Rajat copies it
   into this folder. Nothing in Phase 0 depends on it; it matters from Phase 1 (its O1–O5 are not yet ruled).
5. **A2** — the expiry job decides on `bindingUntil` alone: agreed (§2). The matching `releaseQuote` refusal is
   left for Phase 1.

Still open, none blocking:

- **`messageHi` for `MARKETPLACE_PAUSED`.** No Hindi wording has been provided, so none is sent. It must be
  supplied before `marketplace_paused` is ever switched on in front of buyers.
- **Freezing the 24-hour clocks during a pause** (§3) — a later founder decision.
- **A pool a quote withdrawal's line feeds.** A quote withdrawal that pauses its quote-born line is not held to
  the pool gate (only Stop is). If that line's seller supplies a pool with commitments, the pool is not
  changed either way; say so if the gate should apply there too.

## 7. Seen and left alone (out of scope)

- `pauseListing` and `relistListing` look the seller up with `seller?._id` and pass it straight into the
  listing query; when the caller is not a seller that is `sellerId: undefined`. Worth checking that Mongoose
  treats it as "no match" and not "any seller" — I did not test it, and did not change it.
- `closeParkedQuotes` expires parked quotes when an ask ends but leaves their published listing line live; the
  line then runs its own 45 days with no quote behind it (this is A11's world).
- `undoPileConfirm` does not check that the pile is still `confirmed`: a seller who undoes inside the 5-second
  window after a staff stop declined it would reopen it (decision back to `null`) on a stopped listing. He
  still cannot confirm it (`confirmPile` now refuses), but the pile sits open and Sales is not told. Narrow, and
  left alone; the fix is one condition in `undoPileConfirm`.
- The idempotency middleware stores the response of an invalid request (a 400 from a missing note) under its
  key, so re-sending the _same body with the same key_ replays the 400. The admin app should make a fresh key
  per submit, which it does for its other forms.
