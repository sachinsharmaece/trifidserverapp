# RECTIFY-01 — Plan notes, Phase 0 (server)

Branch `feature/rectify-01-phase0-stop-withdraw`, from `develop` at a0d4c07 (which carries
`pile-fanout-recovery` and, with it, `gst-inclusive-rates`; both confirmed merged before starting).
`LOCK-36` was not in the folder I was given, so nothing here leans on its text; where the brief cites it
the brief's own words were used. No STOP condition was hit (S1–S4): nothing is renamed or removed, no
production data was touched, the baseline built, and the one uncovered state (an open pool with paid
commitments) is refused rather than cascaded over — see "For the founder" below.

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
3. **Two extra flags on the stop script:** `--confirm-pools` (the script's equivalent of the route's
   `confirmPools`, and it refuses to run without it when any listing has an open pool with commitments),
   and `--by <email or id>` / `--out <folder>` (who the audit entries name — default the first active
   Admin — and where the CSVs go — default `trifid data/rectify-01/`, as the purge script's backups do).
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
- **"Open pools on a listing":** a pool belongs to a pack and a condition set, not to one seller (BR-151),
  so the pools on a listing are the active ones its lines' pack + condition-set keys would feed. Only a pool
  with somebody still committed (not withdrawn) counts as "with commitments"; one with a _paid_ commitment
  refuses the stop outright, even for Admin. Pools are never changed by a stop.
- **Quotes withdrawn with a listing:** every `pending_sales`/`live` quote whose `listingLineId` is one of the
  stopped listing's lines — including a quote that reused the seller's own line, because that stock is now
  off the board. (§1.2 step 3's "leave the seller's own line alone" is about withdrawing _one_ quote.)
  Quotes with no `listingLineId` (older rows) are withdrawn only by the scripts' scope or by hand.
- **Who hears (Sales):** for each buyer, his book owner and that owner's Sales Leader; a buyer in the Queue
  or whose owner has left goes to the active Admins (the rate-change notices' fallback). Each person gets one
  notice listing only their own buyers, with boxes. The seller is never named; Purchase gets no notice.
- **Restart on a listing the seller paused:** refused ("the seller paused it, so he relists it himself").
  Restart on a live listing answers `alreadyLive: true`, changes nothing.
- **A staff stop on a listing the seller had already paused** is allowed and takes it out of his hands.
- **HTTP codes:** `MARKETPLACE_PAUSED` is 409 (a state refusal; 503 invites automatic retries, 423 is
  already the sign-in lockout). The pool refusals reuse `PERMISSION_DENIED`, `CONFIRMATION_REQUIRED`
  (already used for "confirm and send again") and `VALIDATION_FAILED` rather than adding codes.
- **A2 (Phase 1) — a seller-paused quote-born line.** Recommended: the expiry job decides on `bindingUntil`
  alone and never looks at the line's state. The seller is bound for 24 h (LOCK-08.7) and the buyer was
  _given_ the rate; his own pause of the line must not shorten that, so the quote stays takeable through the
  ask until the binding runs out, then expires like any other. The job must not un-pause the line.
  Separately, `releaseQuote` (Sales giving a _parked_ quote) does not look at the listing state today, so
  Sales could give a buyer a rate whose line the seller has paused; worth a warning on the Give action.

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

Not guarded, on purpose (the brief lists the seven above and says orders, payments, dispatch and Marg run on):
raising an ask (`raiseAsk`), placing into a pool (`pool.service`), a buyer walking away from a deal, a
seller confirming/declining/undoing a pile, and the fan-out/expiry jobs. If the founder also wants new asks
and pool commitments refused, each is one line in the same style.

## 4. Existing files modified (exact lines in this branch)

| File                                           | Lines                                      | Change                                                                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/app.ts`                                   | 38, 96                                     | import and mount `marketplaceRouter`                                                                                                                                     |
| `src/config/permissions.ts`                    | 141–144                                    | `LISTING_STOP`, `QUOTE_WITHDRAW` (Admin gets them: `Object.values`)                                                                                                      |
| `src/config/positions.ts`                      | 48–53                                      | both granted to `PURCHASE_LEADER`, the way `SALES_APPROVE_RATE_CHANGE` is to `SALES_LEADER`                                                                              |
| `src/models/Listing.ts`                        | 11–24, 42–50                               | `STOP_REASON_CODES`; `stoppedBy`, `stoppedByEmployeeId`, `stopReasonCode`, `stopNote`, `stopBatchId`                                                                     |
| `src/models/Quote.ts`                          | 3, 61–66                                   | `withdrawnAt`, `withdrawnBy`, `withdrawReasonCode`, `withdrawNote`                                                                                                       |
| `src/models/Pile.ts`                           | 40–43                                      | `deskDeclined`                                                                                                                                                           |
| `src/models/StaffNotice.ts`                    | 22–24                                      | kinds `listing_stopped`, `rate_withdrawn`                                                                                                                                |
| `src/shared/errors.ts`                         | 88–90, 141                                 | `MARKETPLACE_PAUSED` (409)                                                                                                                                               |
| `src/modules/listing/listing.service.ts`       | 45, 48, 205, 465–471, 972                  | guard import; `export` on `LISTING_LIFE_DAYS`; guard in `createListing` and `createPileRequest`; `relistListing` refuses a staff-stopped listing                         |
| `src/modules/listing/listing.groups.ts`        | 21–22, 36–40, 57, 65, 84                   | `deskDeclined` ignored when reading a line's latest group                                                                                                                |
| `src/modules/demand/demand.service.ts`         | 38, 349–364, 401, 482, 708, 787, 1045–1051 | guard import; `settleAskAfterQuoteLeaves` (extracted) and its call in `acceptAskFill`; guards in `acceptAskFill`, `postQuote`, `releaseQuote`; `requotePile` kill switch |
| `src/modules/demand/pileOffer.service.ts`      | 19, 194                                    | guard import and call in `acceptPileOffer`                                                                                                                               |
| `src/modules/desk/sales/sales.stageActions.ts` | 26, 59                                     | guard import and call in `giveRateOnAsk`                                                                                                                                 |
| `src/modules/notice/notice.routes.ts`          | 5, 24–32                                   | `GET /staff/notices` also returns the two flags                                                                                                                          |
| `package.json`                                 | scripts                                    | `stop:marketplace`, `restart:stopped`, `audit:rectify01`                                                                                                                 |

Two existing tests changed, because they exercise requote itself and requote is now refused unless
`pile_requote_enabled` is on: `tests/m8.test.ts` ("requoting a pile queues seller_requoted…", the one call
at the requote line) and `tests/optionalCallNote.test.ts` ("requotes and declines with no note", the
requote call). Each now wraps just that call in `withPileRequoteEnabled(...)` (new `tests/requoteFlag.ts`),
which turns the flag on for the length of the call and puts it back. Nothing else in either file changed.

New: `src/modules/marketplace/` (`guard`, `service`, `bulk`, `audit`, `controller`, `routes`, `validation`),
`src/shared/scriptSupport.ts`, `src/scripts/{stopMarketplace,restartStopped,auditRectify01}.ts`,
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

## 6. For the founder (open questions, none blocking the review)

1. **Pool with a paid commitment (S3).** The brief says "STOP S3". A stop is a request a person makes, so the
   server cannot stop and ask; it _refuses_ (409, plain words, nothing changed, even for Admin) and the desk
   settles the pool first. Is refusing the right behaviour, or should Admin be able to override it too?
2. **Open piles on a line that a _quote withdrawal_ pauses.** §1.2 step 3 says "stop the listing as in §1.1
   step 1" — that is only the pause. Buyers who piled on that quote-born line before are _not_ declined (the
   cascade of §1.1 step 3 is the Stop button's). Their piles stay open on a paused line, and the seller can
   still confirm them. The withdraw preview shows `openPilesOnLine` so the person sees it, and Stop on that
   listing closes them. Should a quote withdrawal that pauses its line run the full stop instead?
3. **`messageHi` for `MARKETPLACE_PAUSED`** — no Hindi wording was provided, so none is sent.
4. **Should the seller app be told a listing was stopped by TriFid** (an optional `stoppedBy` on
   `GET /listings/mine`)? Today it sees `paused` and, on trying to relist, the "Call the purchase desk" message.

## 7. Seen and left alone (out of scope)

- `pauseListing` and `relistListing` look the seller up with `seller?._id` and pass it straight into the
  listing query; when the caller is not a seller that is `sellerId: undefined`. Worth checking that Mongoose
  treats it as "no match" and not "any seller" — I did not test it, and did not change it.
- `closeParkedQuotes` expires parked quotes when an ask ends but leaves their published listing line live; the
  line then runs its own 45 days with no quote behind it (this is A11's world).
- The idempotency middleware stores the response of an invalid request (a 400 from a missing note) under its
  key, so re-sending the _same body with the same key_ replays the 400. The admin app should make a fresh key
  per submit, which it does for its other forms.
