# RECTIFY-01 — Contract changes, Phase 0 (server)

**For the Buyer app team.** Server branch `feature/rectify-01-phase0-stop-withdraw`, off `develop`
(a0d4c07). Every entry says what changed, who reads it, and the flag. Nothing is renamed or removed,
no response shape is changed, and no flag is on by default except where the entry says so.

The two switches are `Config` rows, the way `claim_board` is — `PUT /admin/config/:key` (Admin) sets
them, a missing row means off:

| Key                    | Default | Meaning                                                      |
| ---------------------- | ------- | ------------------------------------------------------------ |
| `marketplace_paused`   | off     | While `true`, new trade is refused with `MARKETPLACE_PAUSED` |
| `pile_requote_enabled` | **off** | While off, `requotePile` is refused (see entry 6)            |

---

## A. What a buyer or seller app can meet

### 1. NEW ERROR CODE `MARKETPLACE_PAUSED` — **new error code. The app should show the message and not retry.**

- **Old:** none.
- **New:** HTTP **409**, `error.code = "MARKETPLACE_PAUSED"`, `error.message_en = "Trading is paused for a
short while. The desk will call you."`, `error.retryable = false`. No `message_hi` is sent (no approved
  Hindi wording yet — send it and it is one line).
- **Raised by** (and only while `marketplace_paused` is on): `POST /listings` (a seller's new listing),
  `POST /asks/:id/quotes` (a seller's new quote), `POST /listings/lines/:id/inquire` (a buyer's new pile
  request), `POST /asks/:id/accept` (a buyer taking a quote), `POST /pile-offers/:id/accept` (a buyer
  taking a deal). The same calls made by staff on a phone call (`/staff/proxy/…`, `/staff/sales/…`) are
  refused the same way, as is Sales giving a parked quote or a rate from the board.
- **Not paused:** orders already raised, payments, dispatch, Marg, a buyer walking away from a deal
  (`POST /pile-offers/:id/decline`), a seller confirming or declining a pile, asks (`POST /asks`).
- **Flag:** `marketplace_paused`, default off. With it off, behaviour is as before.

### 2. A seller's `POST /listings/:id/relist` can now be refused

- **Old:** relisting a paused listing always worked (subject to the product still being sold).
- **New:** for a listing TriFid staff stopped, HTTP 400 `VALIDATION_FAILED`, `message_en = "TriFid has
paused this listing. Call the purchase desk."`. The app should show the message. Only the staff
  restart lifts it.
- **Flag:** none — a staff stop is only ever done by a person; nothing changes until one happens.

### 3. A listing can be `paused` by staff — buyer feed and offers need no change

- `Listing.state` is still `live | paused | withdrawn`. Staff use the existing `paused`. The buyer feed,
  product offers, buy screen and pile requests already read `state: 'live'` only (confirmed in
  `findVisibleLines`, `getListingLineForBuy`, `requireLineVisibleToBuyer`), so a stopped listing leaves
  them with no app change.
- A seller's `GET /listings/mine` returns `state: "paused"` for it, indistinguishable from his own
  pause. (No new field was added to that response. If the seller app should say "stopped by TriFid",
  say so and it is one optional field.)
- **Flag:** none.

### 4. A quote can now be `withdrawn` (the status already existed; nothing wrote it before)

- A seller's `GET /quotes` lists it with `status: "withdrawn"` — "withdrawn by TriFid". No strike, no
  rank (`rank`/`ofCount` stay null).
- A buyer's `GET /asks` lists `live` quotes only, so a withdrawn quote simply disappears from his ask.
  If it was the only live quote the ask goes `quoted` → `open` and `holdExpiresAt` becomes `null` — the
  same transition a short fill already makes, so the next quote starts a fresh round.
- **A buyer is never messaged** about a withdrawal or a stop (no WhatsApp, no outbox row). Sales phones him.
- **Flag:** none.

### 5. A staff stop closes open piles as a decline

- Piles with no decision yet on a stopped listing become `decision: "declined"` — the buyer's
  enquiry/pile-request status reads `declined`, as when a seller declines. No strike, no message.
- Deals already offered (BR-378) are **not** touched: they run to the end of their 24 hours and can still
  be taken with `POST /pile-offers/:id/accept` (unless `marketplace_paused` is on).
- Once staff restart the listing, the line takes requests again (the stop's decline does not keep it
  shut, unlike a seller's own decline, which is unchanged).
- **Flag:** none.

### 6. REQUOTE IS OFF — `POST /confirmations/:id/requote` — **a visible change to the seller app, on by default**

- **Old:** a seller could requote a pile; every buyer on it was told "accept or cancel" with nothing to
  accept, and the pile was stranded (RECTIFY-01_PLAN §5.1).
- **New:** with `pile_requote_enabled` off (the default, as the brief requires — it stops new stranded
  piles today), HTTP 400 `VALIDATION_FAILED`, `message_en = "Requote is being rebuilt. Decline or confirm
instead."`. The seller app should show the message and hide the Requote button when it can. Staff on a
  call (`/staff/proxy/seller/confirmations/:id/requote`) get the same refusal.
- **Flag:** `pile_requote_enabled`, **default off**. Remove it when RECTIFY-01 §5 ships.

---

## B. Stored fields added (all optional, with a default, so an old reader sees nothing new)

| Document  | Field                                                                                       | Default | Written by                                                     |
| --------- | ------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------- |
| `listing` | `stoppedBy` (`'staff'`), `stoppedByEmployeeId`, `stopReasonCode`, `stopNote`, `stopBatchId` | `null`  | staff stop; cleared by staff restart                           |
| `quote`   | `withdrawnAt`, `withdrawnBy`, `withdrawReasonCode`, `withdrawNote`                          | `null`  | staff withdraw                                                 |
| `pile`    | `deskDeclined`                                                                              | `false` | staff stop (marks the decline as the desk's, not the seller's) |

`stopReasonCode` / `withdrawReasonCode` are one of `maintenance | stock_gone | rate_wrong |
seller_request | compliance | other`.

New `staff_notice.kind` values `listing_stopped` and `rate_withdrawn` (staff admin app only; the Buyer
app does not read staff notices).

## C. Staff routes (admin app only)

All three need an `Idempotency-Key`. A preview call and the confirming call have **different bodies, so
they need different keys**; send a fresh key per submit.

| Route                              | Permission       | Body → answer                                                                                                                                                                                             |
| ---------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /staff/listings/:id/stop`    | `listing:stop`   | `{reasonCode, note, confirm?, confirmPools?}` → without `confirm: true`: `{confirmed:false, preview}` and nothing is written. With it: `{confirmed:true, stopped, pilesClosed, quotesWithdrawn, preview}` |
| `POST /staff/listings/:id/restart` | `listing:stop`   | `{note?}` → `{restarted, alreadyLive}`                                                                                                                                                                    |
| `POST /staff/quotes/:id/withdraw`  | `quote:withdraw` | `{reasonCode, note, confirm?}` → `{confirmed:false, preview}` or `{confirmed:true, withdrawn, linePaused, preview}`                                                                                       |

- `listing:stop` and `quote:withdraw` are held by Admin and, by position, the Purchase Leader.
- `GET /staff/notices` now also returns `marketplacePaused` and `pileRequoteEnabled` (booleans, optional
  additions) so every desk can show the paused banner.
- Errors: no permission → 403; `confirmPools` needed → 409 `CONFIRMATION_REQUIRED`; a pool with a paid
  commitment → 409 `VALIDATION_FAILED` (the stop is refused; nothing is cascaded over money).

## D. Scripts (run by developers, not the apps)

`npm run stop:marketplace`, `npm run restart:stopped`, `npm run audit:rectify01`. Dry run by default;
refuse any database not in the test allow-list unless `--i-know-this-is-prod`; write a report CSV before
writing anything. **Withdrawn quotes do not come back** with a restart: sellers re-quote and Sales gives
them again.
