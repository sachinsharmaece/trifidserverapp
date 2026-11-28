# The `reference-copy` branch (API side)

This branch rebuilds the reference admin (`D:\trifid\trifid_reference\Admin`, Next.js + Prisma) on our own stack
(Express 5, Mongoose 9, zod 4), screen by screen and "as it is". The reference folder is **read only**: read it, never
change it. When the reference and our older design disagree, this branch follows the reference, and every place where
it could not is listed below.

The admin app's half of the story is in `trifidadminapp/docs/REFERENCE_COPY.md`.

## What came from where

| Build | Reference area                                                                          | Our code (src/modules/…)                            |
| ----- | --------------------------------------------------------------------------------------- | --------------------------------------------------- |
| R1    | Sidebar, Masters, Staff (positions, reports-to), Settings                               | `masters/`, `users/`, `settings/catalogue.ts`       |
| R2    | Purchase desk: Today, Sellers, listings, confirmations, POs                             | `parties/`, `listings/`, `purchaseOrders/`          |
| R3    | Sales desk: buyers, Call screen, call log, asks, sales orders                           | `sales/`, `salesOrders/`, `pricing/board.routes.ts` |
| R4    | Buyer and seller funnels                                                                | `trades/` (read through `view.ts`)                  |
| R5    | Logistics desk: Dock, goods-in, inspection, trips, vehicle owners                       | `dock/`, `trips/`, `logistics/`                     |
| R6    | Accounts desk: Upcoming payments, To be billed, Ledger, Payment, Journal, Ledger master | `payments/`, `billing/`, `books/`, `payouts/`       |
| R7    | Fast order (auto-confirm, order on call, TriFid Stock), credit, the Today pages         | `fastOrder/`, `credit/`, `today/`                   |
| R8a   | SKU price matrix, seller leads                                                          | `pricing/skuMargins.routes.ts`, `sellLeads/`        |
| R8b   | Dormant policy (book, Pool, clocks, Team Leader), staff hierarchy scope                 | `dormancy/`, `parties/staffScope.ts`                |
| R9    | Buyer and seller portals (OTP sign-in), portal logins on party pages                    | `portal/`                                           |
| R10   | Side-by-side check, these notes                                                         | —                                                   |

## Differences from the reference

Each is deliberate. Change one only together with the screen that relies on it.

**Accounts**

- Upcoming payments has no "Old balance" choice: our books have no old-bill settling, so a payment goes to an order
  or "On account". A hand-added row needs its UTR and is dated today.
- Statements and the credit log download as CSV (made in the browser), not PDF.
- Opening balances are typed as an "Opening balances" journal (Dr = Cr, approved by someone else), not on Ledger master.
- Ledger master adds ledgers only under the groups a person may add to; buyers, sellers and banks get theirs from their
  own screens.
- Payment (seller payouts): released by Founder or Admin after a password re-check (not the Controller). A line is paid
  by typing its UTR; a screenshot alone is not taken. Refunds can go in the same payment.
- The reference's older Accounts pages that its own menu no longer links (Receipts, Bank book, Day close, Seller bills,
  Marg, Payouts, Accounts trade queue, the two registers, `/ledgers/buyers|sellers/:id`) were not copied. Our main-branch
  versions of registers, reconciliation and payouts still exist in the API.

**Fast order and credit**

- A credit order is marked PAID with `onCredit: true`, so it flows on to the dock and billing like a paid order; what
  the buyer owes stays on his credit line and ledger.
- "Auto-off on rate change" never fires: our listings never change rate (a new rate is a new listing).
- Payment reminders are not built (the reference schedules them but has no sender either).

**Pricing**

- SKU price matrix: Reject and End-date ask for their reason inline; a new cell starts tomorrow at the earliest.
- Seller-lead reject reasons (`SELL_LEAD_REJECT`) must be added in Masters → Reason codes; none are seeded.

**Dormant policy (R8b)**

- A buyer's bills are only our own sales orders with a Marg bill. The reference also counts Marg bills imported at
  go-live; we have no such import, so the backlog batch usually finds nothing.
- The clock runs once per Indian day from the 15-minute timer, and "Run now" (`POST /clocks/run`) runs it too.
- Holdings, the Pool and the Team Leader's list are for Sales positions JR/SR_SALES_EXECUTIVE (callers) and TM.
- `acquiredById` on buyers and sellers is the owner the staff hierarchy scope filters on. Existing records have none and
  stay visible to everyone, as in the reference.

**Portals (R9)**

- No SMS provider is connected: the sign-in code is written to the server log (`[DEV OTP]`), as the reference does
  without AWS SNS. **Connect a provider in `modules/portal/sms.ts` before real buyers or sellers use the portal.**
- Portal sessions are server-side rows (`party_sessions`, cookie `psid`), not a signed JWT. Suspending a login ends its
  sessions at once.
- "Confirmations" are our trades sent to a seller: PENDING until he answers, then CONFIRMED. A seller's "no" sends the
  trade back without the seller, so declined ones are not listed (the reference keeps a DECLINED row).
- A seller's PO shows his own dispatch (leg 1) instead of the reference's leg 2 (our dock to the buyer).
- An ask's condition note is written by Sales, so the buyer portal does not show it.

**Smaller ones**

- Reason codes: besides the reference's two lists, our engine uses a few more (cancel, refund, complaint…).
- Seller confirmation: expiry is a month; "Any month" is saved as January of that year.
- Our seller side splits the reference's s5 into "on the way" and "at the dock".

## Working on this branch

- Before copying a screen, read its reference page, its API routes and the `lib/` services they call. Match field
  names in responses where the admin app copies the reference page; otherwise keep our conventions (CLAUDE.md).
- A reference rule that cannot be copied as it is goes in the list above, and in the doc comment of the route or page.
- The checks used while copying (one server check and one browser check per build) ran outside this repo and are not
  part of it. Before saving a change run `npm run typecheck`, `npm run lint` and `npm run build`.
