# trifidserverapp

TriFid back-office API: Express 5, MongoDB (Mongoose 9), TypeScript, Zod.

## Run it

```powershell
npm install
copy .env.example .env      # then set MONGODB_URI (must be a replica set, e.g. MongoDB Atlas)
                            # and DATA_ENCRYPTION_KEY (how to make one is in .env.example)
npm run dev                 # http://localhost:4000  (restarts on file changes)
```

Check: http://localhost:4000/health → `{"status":"ok"}` and http://localhost:4000/ready → `ready` once MongoDB is connected.

| Script                   | What it does                                          |
| ------------------------ | ----------------------------------------------------- |
| `npm run dev`            | Start with auto-reload (tsx)                          |
| `npm run typecheck`      | TypeScript check, no output files                     |
| `npm run build`          | Compile to `dist/`                                    |
| `npm start`              | Run the compiled build                                |
| `npm run lint`           | ESLint (`lint:fix` fixes some)                        |
| `npm run db:sync`        | Create collections + indexes                          |
| `npm run db:seed`        | Add default settings (safe rerun)                     |
| `npm run db:seed-demo`   | Add made-up margins and one demo board row (dev only) |
| `npm run create-founder` | Create the first Founder account                      |
| `npm run format`         | Prettier (`format:check` reports)                     |

## Code quality

- **ESLint** (`eslint.config.js`): TypeScript rules that use type information. The valuable ones for an Express API are
  `no-floating-promises` and `no-misused-promises` (a forgotten `await` becomes a build-time error, not a production bug).
- **Prettier** (`.prettierrc.json`): single quotes, 100 columns.
- **Git hook** (Husky + lint-staged): before each commit, ESLint and Prettier run on the staged files and the commit is
  refused if ESLint finds an error. Hooks are switched on by `npm install` _inside a git repository_. If you run
  `git init` or clone after installing, run `npm run prepare` once. Production installs (`npm ci --omit=dev`) skip it.
- **Keep `typescript` on 5.9.x.** `typescript-eslint` is built on TypeScript's JavaScript API, which TypeScript 7 (the
  native compiler) does not provide. Move to 7 only once `typescript-eslint` supports it. `@types/node` is pinned to the
  Node major in `engines` (22) so you cannot accidentally use an API the runtime does not have.
- **About `npm audit`.** It reports a dev-only `picomatch` advisory (GHSA-fc5q-39xc-vjpf) in the lint tooling. No patched
  version exists yet, and it only matters if untrusted text is fed to a glob matcher, which never happens here.
  **Do not run `npm audit fix --force`:** it downgrades `typescript-eslint` and `lint-staged` to versions that do not work
  with ESLint 10 and does not remove the finding. The check that matters for production is `npm audit --omit=dev`
  (it reports 0).

## Database

Mongoose models live in `src/models/` (one plain file per collection, all exported from `src/models/index.ts`).
They contain only the fields needed today; fields for later features (MFA, staff hierarchy, …) are added with
those features.
They follow ARCH §B1: collections `snake_case`, fields `camelCase`, money in integer paise (`…Paise`),
percentages in basis points (`…Bp`, 1800 = 18%), dates in UTC, `_id` never shown to users (they see numbers
like `SO-26-0001` from `nextDocumentNumber()` in `src/db/documentNumbers.ts`). Records are deactivated, never
deleted. Enums are in `src/shared/enums.ts`, GSTIN/IFSC/HSN/pincode checks in `src/shared/validators.ts`.

| Area       | Collections                                                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| System     | `users`, `sessions` (TTL), `counters`, `idempotency_keys` (TTL 72 h), `audit_events` (append-only), `settings`                         |
| Masters    | `company` (single document), `manufacturers`, `technicals`, `hsn_codes`, `products`, `skus`, `tehsils`, `reason_codes`, `margin_cells` |
| Parties    | `sellers`, `buyers` (each party's dealerships are kept on the party itself)                                                            |
| Listings   | `listings` (a seller's offer of one pack)                                                                                              |
| Trades     | `trades`, `trade_events` (append-only), `sales_orders`, `receipts`, `purchase_orders`                                                  |
| Books      | `ledger_groups`, `ledgers`, `vouchers` (append-only)                                                                                   |
| Dock       | `inspections` (append-only), `return_notes`, `refunds`, `seller_strikes`                                                               |
| Trips      | `trips` (one vehicle leaving the dock with its Marg bills and their PODs)                                                              |
| Payouts    | `payout_batches` (a batch of seller payments and buyer refunds, its lines kept inside it)                                              |
| Complaints | `complaints` (a buyer's complaint after dispatch, and the Controller's decision on it)                                                 |

First time on a database (after `.env` points at it):

```powershell
npm run db:sync   # creates the collections and their indexes (unique, TTL); safe to rerun
npm run db:seed   # adds the default settings; never overwrites values an admin changed
```

Then create the first account, so someone can sign in (it asks for name, email and a password of 10+ characters):

```powershell
npm run create-founder
```

Run `db:sync` again whenever a model's indexes change. Company, HSN codes, reason codes, margin cells,
tehsils and products are real business data: they are entered by Admin or imported, not seeded.

To try the Margin matrix screen before the client sends the real margins, `npm run db:seed-demo` adds 12 **made-up**
margin cells (needs the Founder account from the step above; it refuses to run when `NODE_ENV=production`). It skips any
class × tier that already has a cell, so it is safe to re-run and never touches a real value.

It also adds one Rate board row to practise a deal on (`db/seed/demoBoard.seed.ts`): the seller **Demo Seller
Agency** lists **Demo Insecticide 500 ML** (class A, 20 per box) at ₹500.00 per unit, and the buyer **Demo Krishi
Kendra** is a classified Dealer, so the board shows him ₹550.00 per unit (10% demo margin). It adds the masters it
needs (tehsil Mhow, Demo Crop Care, HSN 3808) only if missing, and skips anything already there. Turn the demo seller,
buyer and product off in the app when you no longer want them.

## Layout

```
src/
  server.ts            start-up: connect DB, listen, graceful shutdown
  app.ts               middleware order: requestId → helmet → cors → json → /health,/ready → /api/v1 → 404 → errors
  config/env.ts        reads + validates .env (fails fast)
  db/connect.ts        MongoDB connection
  db/documentNumbers.ts  SO-26-0001 style numbers (atomic counters, Indian financial year)
  db/seed/             default reference data (settings)
  models/              Mongoose models, one per collection (index.ts lists them all)
  scripts/             db-sync.ts, db-seed.ts, db-seed-demo.ts (npm run db:sync / db:seed / db:seed-demo)
  middleware/          requestId (more later: idempotency)
  routes/index.ts      the /api/v1 router — mount feature modules here
  modules/<feature>/   one folder per feature (health, auth, users, masters, parties, listings, pricing, trades,
                       salesOrders, payments, purchaseOrders, books, dock, billing, trips, payouts, complaints, clocks today)
  shared/              errors (HttpError + error envelope), audit (writeAudit), mongo (duplicate-key helper), logger,
                       shutdown, enums, validators
  types/               Express type additions (req.requestId, req.user)
```

## API conventions (the admin app depends on these)

- All app endpoints are under **`/api/v1`**. The probes `/health` and `/ready` stay at the root for load balancers, and are
  also mounted at `/api/v1/health` and `/api/v1/ready` so the admin app can reach them through its proxy.
- Every error response: `{ "error": { "code", "message", "details"?, "requestId" } }`. Throw `HttpError` (or `badRequest`, `notFound`, …) from `shared/errors.ts`; Zod errors become `422 VALIDATION_FAILED`.
- Every response has an `X-Request-Id` header; the same id is in error bodies and logs.
- Money is always integer paise; never floats.
- The error envelope and the `/ready` response are mirrored in the admin app (`trifidadminapp/src/services/api/errorEnvelope.ts`
  and `system.ts`). Change both together.

## Sign-in (modules/auth)

- `POST /api/v1/auth/login` `{ email, password }` → `{ user }` and the cookie `sid`. `POST /api/v1/auth/logout` → 204.
  `GET /api/v1/me` → `{ user }`, or 401 when nobody is signed in. `user` is `{ id, email, name, role, mustChangePassword }`.
- `POST /api/v1/auth/password` `{ currentPassword, newPassword }` (10+ characters) → `{ user }` and a new cookie. Ends the
  person's other sessions. New and reset accounts have `mustChangePassword: true`; until they change it, every route
  except `/me` and `/auth/password` answers 403 `PASSWORD_CHANGE_REQUIRED`.
- Passwords are stored as argon2id hashes. The cookie holds a random token; the database keeps only its hash
  (`sessions._id`), so deleting the session row signs that person out at once.
- A session ends after 12 hours without a request, or 7 days in total. 5 wrong passwords lock the account for 15 minutes.
- **Step-up** (`requireStepUp` in `stepUp.ts`): a sensitive route answers 428 `STEP_UP_REQUIRED` unless the session
  re-checked its password within `STEP_UP_MINUTES` (5). `POST /api/v1/auth/step-up` `{ password }` → 204 does that check
  and stamps `sessions.stepUpAt`. A wrong password is 400 `WRONG_PASSWORD` (not 401, which would sign the person out) and
  counts toward the same 5-wrong lock as sign-in; a locked account gets 429 `ACCOUNT_LOCKED`. Signing in does not set
  `stepUpAt`. Today only changing a margin needs it. It is a password re-check because MFA is not built (Q-ROL-03).
- The cookie is `httpOnly` and `SameSite=Strict` (and `Secure` in production). In development the admin app calls the API
  through Vite's proxy, so both are on one origin.

## Staff accounts (modules/users)

Founder and Admin only (`requireRole`). Everyone else gets 403 `FORBIDDEN`.

| Call                                    | What it does                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| `GET /api/v1/users`                     | List all staff (no paging: a company has a handful)                                   |
| `POST /api/v1/users`                    | `{ name, email, role }` → creates the account, returns a one-time `temporaryPassword` |
| `PATCH /api/v1/users/:id`               | `{ name?, role?, active? }`. A role change or turning off ends that person's sessions |
| `POST /api/v1/users/:id/reset-password` | New one-time `temporaryPassword`; unlocks the account and ends its sessions           |

Rules: only a Founder can create, edit or reset a Founder (otherwise an Admin could make themselves one); nobody can
change their own role, turn themselves off or reset their own password here. Accounts are never deleted. Every create,
update and reset writes a line to `audit_events` (never the password). A duplicate email answers 409 `EMAIL_TAKEN`.

## Masters (modules/masters)

Everyone signed in can read (except the margin matrix, below); only Founder and Admin can change (`canEditMasters` in `permissions.ts`). Nothing is
deleted: turn it off with `active: false`. Every change writes a line to `audit_events` with only the fields that changed.
Names are unique ignoring case and extra spaces (409 `NAME_TAKEN`; HSN codes: 409 `CODE_TAKEN`; packs: 409 `PACK_TAKEN`).

| Call                                                  | What it does                                                                                                                                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET/POST /manufacturers`, `PATCH /manufacturers/:id` | `{ name }`; patch `{ name?, active? }`                                                                                                                                                        |
| `GET/POST /technicals`, `PATCH /technicals/:id`       | `{ name, description? }`; patch `{ name?, description?, active? }`                                                                                                                            |
| `GET/POST /hsn-codes`, `PATCH /hsn-codes/:id`         | `{ code (4/6/8 digits), description?, gstBp }`; patch `{ description?, gstBp?, active? }` (code never changes)                                                                                |
| `GET /company`, `PUT /company`                        | `{ company }` (`null` before setup). PUT `{ name, gstin, address, bank: { accountNumber?, ifsc, bankName } }` creates or changes the one record. Send no account number to keep the saved one |
| `GET /products?q=&page=&pageSize=`                    | `{ products, total, page, pageSize }`, each product with its packs; `q` searches the name; A to Z                                                                                             |
| `GET /products/:id`                                   | One product with its packs                                                                                                                                                                    |
| `POST /products`                                      | `{ name, category?, manufacturerId, technicalId, hsnCodeId, taxBp?, skus: [...] }`: at least one pack, saved with the product in ONE transaction                                              |
| `PATCH /products/:id`                                 | Any of the product fields and `active`. Only newly chosen manufacturer/technical/HSN must be active                                                                                           |
| `POST /products/:id/skus`, `PATCH /skus/:id`          | Add a pack; patch `{ packLabel?, unitsPerBox?, skuClass?, active? }`                                                                                                                          |
| `GET /tehsils?q=&page=&pageSize=&active=`             | `{ tehsils, total, page, pageSize }`; `q` is a 6-digit pincode, or part of the state / district / tehsil name; `active=true` or `false` filters; sorted by state, district, name              |
| `POST /tehsils`, `PATCH /tehsils/:id`                 | `{ state, district, name, pincodes: [] }`; patch any of them plus `active`. Same state + district + name twice: 409 `TEHSIL_TAKEN`                                                            |
| `GET /reason-codes?context=&active=`                  | `{ reasonCodes }` sorted by context, then `sort`, then label                                                                                                                                  |
| `POST /reason-codes`, `PATCH /reason-codes/:id`       | `{ code (CAPITALS_AND_DIGITS), label, context, sort? }`; patch `{ label?, sort?, active? }` only: code and context never change. Duplicate: 409 `CODE_TAKEN`                                  |

`taxBp` defaults to the HSN code's rate. Changing an HSN code's GST rate does not change products that use it: each
product keeps its own `taxBp`.

**Company bank number.** `PUT /company` locks the account number with AES-256-GCM (`src/shared/encryption.ts`, key
`DATA_ENCRYPTION_KEY`) and saves the locked text plus the last 4 digits. The API only ever returns `accountLast4`; the
audit log says `accountNumber: 'replaced'` and never holds the number. Nothing reads the full number back yet (the
proforma and payout files will, later, through `decryptText`). Without the key the server still runs; only saving a bank
number fails (500 `ENCRYPTION_KEY_MISSING`). If the key is lost the saved number cannot be read: type it in again. This
is simpler than the KMS data key in ARCH §B12.2: one key from `.env` (a secret store in production); key rotation is not built.

A reason code belongs to one `context` (`BUYER_NO`, `B6_LEAK`, `CANCEL_SO`, `REFUND`, `COMPLAINT`, `MARG_QUERY`,
`SELL_LEAD_REJECT`, `CALL_OUTCOME`); screens ask for `?context=...&active=true` so a reason shows only where it is used.
Pincodes are 6 digits, not starting with 0; duplicates inside one tehsil are dropped.

### Margin matrix (`marginCells.routes.ts`)

The parent matrix: a margin (basis points) for each SKU class (A, B, C) and buyer tier (Trader, Distributor, Dealer,
Retailer). It is on the visibility wall, so it is **not** open to everyone like the other masters: reading is for
Controller, Founder and Admin (`canSeeMargins`), changing is for Founder and Admin (`canEditMasters`) and also needs a
step-up. Sales, Purchase, Accounts and Logistics get 403 on both.

| Call                 | What it does                                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /margin-cells`  | `{ cells }`, each `{ id, skuClass, buyerTier, marginBp, effectiveFrom, status, createdBy, createdAt }`; sorted by class, then tier, then newest first                                                              |
| `POST /margin-cells` | `{ skuClass, buyerTier, marginBp (0 to 10000), effectiveFrom? }` → 201 `{ cell }`. No `effectiveFrom` means now. A start in the past is 400; one not later than the pair's latest cell is 409 `MARGIN_CELL_EXISTS` |

A cell is **never edited or deleted** (the model makes its fields immutable). To change a margin you add a new cell that
starts now or later; pricing will use the newest cell with `effectiveFrom` ≤ now. `status` is worked out by the server:
`CURRENT` (the newest cell that has started), `SCHEDULED` (not started yet) or `PAST` (replaced). Every new cell writes a
`margin_cell.create` line to the audit log. Not built: the SKU ₹/unit matrix with maker–checker (P2, Q-PRC-02), the tier
order rule (BR-30 applies to those SKU cells), and the real margin values (Q-PRC-07): the table starts empty and the
screen shows "Not set" until a Founder or Admin enters them. For development, `npm run db:seed-demo` fills the 12 boxes
with made-up values starting 1 Jan 2026 (`effectiveFrom` = `2025-12-31T18:30:00Z`, in the Founder's name). A real value
entered on the screen starts later and takes over; the made-up cell then shows as "Replaced". The app cannot delete a
cell, so to remove the made-up ones completely delete the `margin_cells` documents with that `effectiveFrom` in MongoDB
Compass or mongosh.

## Parties (modules/parties)

Sellers (who we buy from) and buyers (who we sell to). The visibility wall is enforced here: `/sellers` is for Purchase,
Controller, Founder and Admin; `/buyers` is for Sales, Controller, Founder and Admin; any other role gets 403
(`modules/parties/permissions.ts`). Founder and Admin have every right, so they are on both sides (Q-ROL-01, decided).

| Call                                      | What it does                                                                                                                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /sellers?q=&page=&pageSize=&active=` | `{ sellers, total, page, pageSize }`; `q` is a number like `SEL-0007`, part of the firm or contact name, or the start of a mobile number or GSTIN; sorted by firm name                                       |
| `GET /sellers/:id`                        | `{ seller }`                                                                                                                                                                                                 |
| `POST /sellers`                           | `{ firmName, gstin, mobile, contactName?, tehsilId, address?, dispatchCutoff ("17:30"), manufacturerIds?, bank: { accountNumber, ifsc, bankName, holderName } }` → 201 `{ seller }` with the next `SEL-0001` |
| `PATCH /sellers/:id`                      | Any of those plus `active`. `bank` may hold only the parts that change; no `accountNumber` keeps the saved one. An empty `contactName` or `address` clears it                                                |
| `GET /buyers?q=&page=&pageSize=&active=`  | `{ buyers, total, page, pageSize }`, searched the same way (any of the buyer's mobile numbers)                                                                                                               |
| `GET /buyers/:id`                         | `{ buyer }`                                                                                                                                                                                                  |
| `POST /buyers`                            | `{ firmName, contactName, mobiles (1 to 5), gstin?, tehsilId, village?, address, deliveryLocation, tradePosition, traderFlag, manufacturerIds? }` → 201 `{ buyer }` with the next `BUY-0001`                 |
| `PATCH /buyers/:id`                       | Any of those plus `active`. An empty `gstin` or `village` clears it                                                                                                                                          |
| `POST /buyers/:id/classify`               | Confirms the buyer's rate tier (`classified: true`). Doing it again changes nothing                                                                                                                          |

- **Numbers.** `nextPartyNumber('SEL' | 'BUY')` in `src/db/documentNumbers.ts`: one counter per kind, never reset by year,
  taken inside the same transaction as the create, so a refused request leaves no gap.
- **Duplicates.** A seller with the same GSTIN, mobile or bank account is refused with 409 `SELLER_EXISTS`; a buyer with
  the same GSTIN or any same mobile with 409 `BUYER_EXISTS`. The message names the party that already has it
  (`... seller SEL-0003 (Firm name)`). The unique indexes are the last guard if two people save at the same moment.
- **Seller bank number.** Locked with AES-256-GCM exactly like the company's (see above); the response has `bank.accountLast4`,
  never the number. Because the locked text is different every time, the "same bank account" check uses `hashText()`:
  a one-way fingerprint (HMAC-SHA256 with a key made from `DATA_ENCRYPTION_KEY`). A seller therefore needs the key to be
  saved. If the key is ever changed, old fingerprints no longer match new ones and that one check stops catching old accounts.
- **Dealerships.** A dealership is a party's link to a manufacturer it deals in. As ARCH §B3.3 says, it is the list
  `manufacturerIds` on the seller or buyer itself (the old prototype's `SellerManufacturer` and `BuyerManufacturer`
  join tables are not needed). Only manufacturers newly added must be active, so a manufacturer turned off later does
  not block edits.
- **Tehsil.** Must exist and be active when chosen (the same rule for a change; the old one may stay if turned off later).
- **Buyer state code.** `stateCode` is the first 2 digits of the GSTIN. With no GSTIN (a consumer, B2C) it comes from the
  tehsil's state through the table in `src/shared/gstStates.ts`; an unknown state is a 400 asking for a GSTIN. It is worked
  out again whenever the GSTIN or tehsil changes. Later it decides CGST + SGST (Madhya Pradesh, `23`) or IGST.
- **Rate tier.** `rateTier` is `TRADER` when `traderFlag` is on, else the `tradePosition`. A buyer is `classified: false`
  (the tier is only indicative) until someone calls `/classify`. The PRD's automatic classification at the first
  confirmed order is not built because there are no orders yet.
- **Audit.** `seller.create|update`, `buyer.create|update|classify`; updates record only the fields that changed, and a
  new bank number is logged as `accountNumber: 'replaced'`.
- **Active filter.** Both lists take `active=true` or `false` (anything else is a 422). The listing form's seller picker
  uses `active=true`.

## Listings (modules/listings)

A listing is one seller's offer of one product pack: the rate, the shelf life left, the minimum order (MOQ) and the
quantity in boxes, and where the goods come from. It is Purchase work, so it has the seller side's wall: Purchase,
Controller, Founder and Admin; any other role gets 403 (`canUseListings` in `modules/parties/permissions.ts`, today the
same as `canUseSellers`). Every listing is visible all over India (a tehsil-scoped view is shelved, Q-PUR-07).

A request body is `{ sellerId, skuId, rateType: 'FOR', ratePaisePerUnit }` or
`{ sellerId, skuId, rateType: 'EX', exRatePaisePerUnit, colPaisePerBox }`, plus `expiryBand` (`M6_TO_9`, `M9_TO_12`,
`M12_PLUS`), `moqBoxes`, `quantityBoxes` and `provenance` (`OWN_STOCK`, or `SOURCED`, shown to people as "Company
billing"). All money is whole paise.

| Call                                                        | What it does                                                                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /listings?q=&page=&pageSize=&status=&sellerId=&skuId=` | `{ listings, total, page, pageSize }`, newest first; `q` is a seller number, part of the firm name, or part of the product name      |
| `POST /listings/preview`                                    | The same body as the create; saves nothing. `{ unitsPerBox, landedPaisePerUnit, boxValuePaise, lotValuePaise, duplicate, decrease }` |
| `POST /listings`                                            | The body above, plus `confirmDecrease?` → 201 `{ listing }`                                                                          |
| `PATCH /listings/:id`                                       | `{ status: 'PAUSED' \| 'ACTIVE' \| 'WITHDRAWN' }` → `{ listing }`                                                                    |

- **Landed rate.** The stored `ratePaisePerUnit` is always the landed per-unit rate, so everything later uses one figure.
  FOR: the rate as given. EX: `Ex rate + COL per box ÷ units per box`, rounded to a whole paise (`landedRate()` in
  `modules/listings/rates.ts`). The raw Ex rate and COL are kept for audit. A box is `landed × units per box`; the MOQ lot is
  `box × moqBoxes`. The pack's units per box is copied onto the listing (`unitsPerBoxSnapshot`).
- **Who and what.** The seller, the pack and its product must all be active, otherwise 400.
- **Duplicates.** The same seller, pack, rate type, landed rate, shelf life, MOQ and source as a live (ACTIVE) listing is 409
  `LISTING_EXISTS`. The quantity is not part of it. The unique index on `dedupeKey` (live listings only) is the last guard.
  Paused listings do not count, so resuming one while a live twin exists is also refused.
- **Rate drops.** A new rate lower than the seller's latest live listing of the same pack by more than
  `RATE_DECREASE_CONFIRM_BP` (seeded as 200, i.e. 2%; exactly 2% is allowed) is refused with 409
  `RATE_DECREASE_NEEDS_CONFIRMATION` (`details: { fromPaisePerUnit, toPaisePerUnit, pctBp }`) unless the body has
  `confirmDecrease: true`; the listing then keeps `decreaseConfirmed` (old rate, percent, who, when). Two Ex listings are
  compared on the Ex rate (a COL change alone is not a drop); FOR against EX compares landed rates. Paused, withdrawn and
  expired listings are not "the last one". `POST /listings/preview` returns the same `decrease`, so the screen can warn
  before saving.
- **Life.** A listing lives `LISTING_LIFE_DAYS` (seeded as 45) from the day it is added (`expiresAt`). There is no scheduler
  yet: every list, preview, create and change first calls `expireOldListings()`, which marks live or paused listings
  past `expiresAt` as EXPIRED. A daily job can call the same function later.
- **Changes.** ACTIVE and PAUSED switch both ways; WITHDRAWN is final. EXPIRED and WITHDRAWN listings are closed (409
  `LISTING_CLOSED`); asking for the status a listing already has changes nothing and writes no audit row. A listing is
  never edited: to change a rate, withdraw it and add a new one, so the history stays honest.
- **Audit.** `listing.create` (with `decreaseConfirmedPctBp` when a drop was confirmed) and `listing.update` (status
  before and after). The settings `RATE_DECREASE_CONFIRM_BP` and `LISTING_LIFE_DAYS` come from the `settings` collection
  (`npm run db:seed` adds them); if one is missing, 200 and 45 are used.
- **Privacy.** A listing response names the seller (number and firm name) and the pack. It never carries the seller's GSTIN,
  mobile number or bank details.

## Pricing and the rate board (modules/pricing)

How the rate a buyer sees is worked out, and the Sales price list built on it. `pricing.ts` is the only place that
makes a buyer rate (SRS-PRC-01), so a board, a quote and an order can never disagree:

- `computeBuyerRate(landedPaisePerUnit, marginBp)` = landed + `round(landed × margin ÷ 10,000)`. Example: landed ₹500.00
  (50000) at 20% (2000 bp) → 50000 + 10000 = ₹600.00. A listing's stored rate is already the landed rate (an Ex offer has
  had its COL added), and the margin is applied to that, never to the bare Ex rate.
- `loadMargins(at)` reads the margin matrix once: for each class × tier the newest cell whose `effectiveFrom` has passed.
  A cell dated in the future is ignored until its day. `marginFor(class, tier)` is `null` when there is none.
- `pricingTierOf(buyer)`: a buyer who is not classified yet is priced as RETAILER and the rate is "indicative"
  (SRS-SAL-02). Once classified ("Classify now") he is priced at his own tier.

| Call                                       | What it does                                                                                                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /buyers/:id/board?q=&page=&pageSize=` | `{ buyer: { id, number, firmName, tier, indicative }, rows, total, page, pageSize }`. For Sales, Controller, Founder and Admin (the same wall as `/buyers`; Purchase, Accounts and Logistics get 403). `q` searches the product name |

A row is one live offer (listing ACTIVE and not past `expiresAt`, pack and product turned on):
`{ id, productName, manufacturerName, packLabel, unitsPerBox, buyerRatePaisePerUnit, boxValuePaise, expiryBand, moqBoxes,
quantityBoxes }`. Rows are sorted by product, then pack, then lowest rate. `buyerRatePaisePerUnit` and `boxValuePaise` are
`null` when the margin matrix has no cell for the pack's class and the buyer's tier: the screen shows "Rate unavailable:
margin cell missing" (SRS-MST-05). The box value uses the units per box the listing was made with.

**The wall.** The response is built from the buyer's side only: it holds no seller, no seller rate (the landed rate), no
margin and no pack class; the API leaves them out, it does not hide them. The same fields go to every role. A turned-off
buyer is 409 `BUYER_INACTIVE`; an unknown id is 404. The board only reads: it writes nothing, not even an audit line.
It loads all live offers and pages them in memory, which is fine for a few thousand offers; use an aggregation if it
ever gets bigger. Opening a row as a deal card, "He wants it" and asks are trade engine commands (next section).

## Trades: the one engine (modules/trades)

A trade is one buyer wanting one product. It has two stage tracks: the **buyer stage** (Sales' side, b1…) and the
**seller stage** (Purchase's side, s0…). Q-WF-01 was decided as Option 3: **one engine**. Only `engine.ts` writes the
`trades` and `trade_events` collections. The deal card and, later, the desk queues press the same actions, so a rule
lives in one place. Built so far (up to the buyer's order):

```
Rate board ─ Open ─▶ b1 Viewing ─ He wants it ─▶ b2 Inquiry ─ Send to seller ─▶ b3 Pending seller ─▶ b4 Send confirmation
Ask (not listed) ──────────────────────────────▶ b2 Inquiry      │ listing still live: s1 Seller confirmation
                                                                 │   Seller confirms ─▶ b4   Seller declines ─▶ back to b2
                                                                 │ no live listing (an ask, or after a decline): s0 Find a seller
                                                                 │   Record the quote ─▶ s1 + b4
b4 ─ Send to buyer ─▶ b5 Buyer's call ─ Buyer says yes ─▶ b6 Order confirmed (sales order raised; seller s2 Hold for payment)
                                     └ Buyer says no ─▶ Leakage (seller Released)
b6 ─ Buyer drops the order ─▶ Leakage (order cancelled; seller Released)      Leakage ─ Reopen ─▶ b2 Inquiry
b6 ─ Enter payment (Sales) ─▶ Confirm payment (Accounts) ─ paid in full ─▶ b7 Paid + s3 PO raised
                                                        └ less ─▶ stays b6 (an advance; enter the rest)
s3 ─ Record dispatch (Purchase) ─▶ s5 On the way ─ Goods arrived (Logistics) ─▶ s5 At the dock
   ─ Check the goods (Logistics) ─ some accepted ─▶ b8 Billing + s6 Checked: to be paid
                                  └ nothing accepted ─▶ Dock rejected + Closed ─ Reopen (Sales) ─▶ b2
b8 ─ Marg bill (Accounts) ─▶ b8 (waiting for a trip) ─ Proof of dispatch (Logistics, trip out) ─▶ b9 Dispatched
b9 ─ Delivered (Sales) ─▶ b10 Delivered
s6 ─ Payout batch built (Accounts) ─ released (Founder/Admin) ─ UTR typed (Accounts) ─▶ seller Closed (paid)
```

| File               | What is in it                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `actions.ts`       | The action table: each action's button label, which desk presses it, and from which stage (data, no code)                                  |
| `commands.ts`      | One handler per action: checks its input and business rules and returns the change to save                                                 |
| `engine.ts`        | `runTradeAction` (the checks in a fixed order, then one transaction: save, `trade_events` line, audit line), `openViewing`, `askNotListed` |
| `view.ts`          | What each role may see of a trade (the wall), its buttons, its due time and its history                                                    |
| `stages.ts`        | Stage labels and the expiry-month maths (Indian time)                                                                                      |
| `trades.routes.ts` | The routes below                                                                                                                           |

| Call                                            | Who                                  | What it does                                                                                                            |
| ----------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `POST /trades/open-viewing`                     | Sales, Founder, Admin                | `{ buyerId, listingId }` → 201 `{ trade }` at b1, or 200 with his open b1 for that listing (no duplicates)              |
| `POST /trades/asks`                             | Sales, Founder, Admin                | `{ buyerId, productId, skuId?, boxes, reason, note? }` → 201 at b2. No `skuId` = any pack. A note is needed for `OTHER` |
| `GET /trades/buyer-side?stage&q&page&pageSize`  | Sales, Controller, Founder, Admin    | Buyer funnels: `{ counts, trades, total, page, pageSize }`, rows name the buyer                                         |
| `GET /trades/seller-side?stage&q&page&pageSize` | Purchase, Controller, Founder, Admin | Purchase's queue: only trades sent to the seller side; rows name the seller                                             |
| `GET /trades/:id`                               | both sides                           | `{ trade }` built for the person's role. 404 if he may not see it                                                       |
| `POST /trades/:id/actions/:action`              | the action's desk, Founder, Admin    | `{ version, ...fields }` → `{ trade }`                                                                                  |

The actions: `wantIt {boxes}` (Sales, b1; at least the listing's minimum order), `sendToSeller {}` (Sales, b2),
`confirmStock {boxes, expiryMonth, batchNumber?}` (Purchase, s1; the batch is needed for the seller's own stock),
`declineStock {reason, note?}` (Purchase, s1; the trade goes back to b2 and leaves the seller side) and `giveQuote {sellerId,
skuId, landedPaisePerUnit, expiryMonth, moqBoxes, boxesAvailable, batchNumber?}` (Purchase, s0; the buyer is offered the
smaller of what he wants and what the seller has, which must reach the seller's minimum). `expiryMonth` is `YYYY-MM` and
must be at least `SHELF_LIFE_FLOOR_MONTHS` (6) months away; the message names the earliest month allowed.

Then, all Sales: `sendToBuyer {}` (b4 → b5; if the margin matrix had no box when the seller answered, the rate is worked
out now, and with still none it is 409 `RATE_UNAVAILABLE`), `buyerYes {}` (b5 → b6 and seller s2: raises the sales order,
next section; a turned-off buyer is 409 `BUYER_INACTIVE`), `buyerNo {reasonCodeId, note?}` (b5 → Leakage, seller
Released), `leakAfterOrder {reasonCodeId, note?}` (b6 → Leakage: cancels the order; refused with 409 `ORDER_HAS_PAYMENT`
once money is received, as refunds are not built yet) and `reopen {}` (Leakage → b2: clears the seller side, the offer,
the loss reason and the order link, so "Send to seller" starts afresh; the cancelled order stays on record). A reason
must come from the reason codes master, turned on and of the right context (BUYER_NO, B6_LEAK), else 422 on
`reasonCodeId`. The loss reason is on the buyer side only; Purchase reads "the seller may sell the stock".

At b6 (Gate A, next sections): `enterPayment {bankLedgerId, utr, amountPaise, receivedOn}` (Sales), and
`confirmPayment {receiptId}` / `rejectPayment {receiptId, note}` (Accounts). The trade moves only when a confirmed
payment makes the order paid in full: b6 → b7, s2 → s3, and the PO is raised.

After the PO (Build 3, next sections): `recordDispatch` and `recordSellerBill` (Purchase), `recordArrival` and
`inspectLot` (Logistics, from the Dock screen).

To the buyer (Build 4, sections "Marg bill" and "Trips"): `recordMargBill` (Accounts, b8, from To be billed),
`recordPod {ref, date}` (Logistics, b8 → b9, from Trips) and `confirmDelivery {}` (Sales, b9 → b10: the order is
DELIVERED).

After the goods are out (Build 6, section "Complaints and clocks"): `raiseComplaint` (Sales, b9 or b10, inside the delivery
window → b11) and `resolveComplaint` (the Controller, b11 → b10). `silenceDelivery` is the system's own action: it is
`systemOnly` in `actions.ts`, so no person can press it (403 "The system does this when the time is up.") and it never
shows on a card.

To the seller (Build 5, section "Payouts"): `recordSellerPayment` (Accounts, s6 → Closed). It needs a batch and a line,
so it is pressed from Payouts (`POST /payout-batches/:id/lines/:lineId/proof`), not from the card: `onCard: false` in
`actions.ts` keeps its button off the deal card.

**Who presses.** Each action belongs to one desk (Sales, Purchase, Accounts or Logistics). Founder and Admin may press every button too,
because they have every right (Q-ROL-01, `canPress` in `actions.ts`). The Controller sees both sides but presses nothing
here; the history and `trade_events` record who pressed and with which role.

**Checks, always in this order:** signed in → your desk (403 "Purchase does this.") → the right stage (409 `WRONG_STAGE`)
→ nobody moved it since you loaded it (409 `STALE_TRADE`: the body's `version` must match) → the input (422
`VALIDATION_FAILED` with field messages) → the business rules (409/422). The save is
`updateOne({ _id, version }, { …, $inc: { version: 1 } })`, so two people pressing at once cannot both win.

**The wall.** `view.ts` builds the answer per role. The buyer side (`buyer`, `boardOffer` = the live board rate before
the seller answers, `offer` = the rate fixed when the seller confirms or quotes) goes to Sales, Controller, Founder and
Admin. The seller side (`seller`, `listing` with its landed rate, `sellerAnswer`) goes to Purchase, Controller, Founder
and Admin. Purchase sees a trade only once it is sent to the seller side. The margin is never sent. Each history line has
a buyer note and a seller note, and each person reads only his side's note.

**Clocks** (`dueAt`, from settings): `SLA_S0_HOURS` (7) for Purchase to find a seller, `SLA_S1_HOURS` (12) for the seller
to confirm, `SELLER_HOLD_HOURS` (24) that the seller holds the stock after confirming (it keeps running at b5), and
`PAYMENT_WINDOW_HOURS` (24) for the buyer to pay once his order is raised (b6), `SLA_S3_HOURS` (8) for the seller
to dispatch once the PO is raised (b7 / s3), `TRANSIT_OVERDUE_DAYS` (4) for the goods to reach the dock, and
`INSPECTION_HOURS` (24) for the dock to check them after arrival, and `DELIVERY_WINDOW_DAYS` (7) from the proof of
dispatch for Sales to confirm the delivery (b9, "Delivery window ends"), and `SLA_B11_HOURS` (48) for the Controller to
decide a complaint (b11, "Controller to decide by"). Shown as "Next" on the lists. Only the delivery clock acts by
itself (`modules/clocks`, next sections); the other clocks still only show.

Kept simple on purpose: the ask and the seller's answer are stored inside the trade (no separate collections); decline
reasons are a fixed list; the buyer rate is fixed at the seller's answer. There is no `Idempotency-Key` check yet (none of the API has
one): the version check is what stops a double press from moving a trade twice. The lists page in memory, like the
rate board.

## Sales orders (modules/salesOrders)

An order (`SO-26-0001`) is what the buyer agreed to buy and must pay for. Only the trade engine makes or changes one:
`raiseSalesOrder` runs inside `buyerYes` and `cancelSalesOrder` inside `leakAfterOrder`, in the engine's transaction,
each with its own audit line (`salesOrder.raise`, `salesOrder.cancel`). The routes only read.

- Everything is copied onto the order when the buyer says yes: the buyer (number, firm, GSTIN, state, delivery place,
  tier), and the line (product, pack, units per box, HSN, class, boxes, expiry, batch, seller rate, our rate, box value,
  line total, GST rate). Later changes to the buyer, the pack or the margins never change an order.
- Money: rates include GST. Box value = our rate × units per box; line total = box value × boxes; `totalPaise` = the
  line total. `splitGst(total, taxBp, interState)` in `shared/money.ts` works the tax back out:
  taxable = round(total × 10,000 ÷ (10,000 + taxBp)); another state → IGST = the rest; same state → SGST = half rounded
  up, CGST = the rest. Example (ARCH): ₹32,400.00 at 18% in Madhya Pradesh → 2,745,763 + 247,118 + 247,119 paise.
  "Same state" = the buyer's state code equals the company's (from its GSTIN; 23, Madhya Pradesh, until that is set).
- `paymentDueAt` = now + `PAYMENT_WINDOW_HOURS` (24); the trade's clock shows it as "Payment due". `paidPaise` = the
  payments Accounts confirmed; at the total the order is PAID (`paidAt`). The order view lists its `payments`.

| Call                                           | Who                                         | What it does                                                                                           |
| ---------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `GET /sales-orders?q=&status=&page=&pageSize=` | Sales, Accounts, Controller, Founder, Admin | `{ salesOrders, total, page, pageSize }`, newest first; `q` = order no. or buyer                       |
| `GET /sales-orders/:id`                        | the same                                    | `{ salesOrder }`. Controller, Founder and Admin also get `seller` and each line's `landedPaisePerUnit` |

Purchase and Logistics get 403: an order names the buyer. The margin is never sent. Not built yet: insurance on the order
(Q-SAL-04, open), the proforma PDF, cancelling an overdue order from the order page (the deal card's "Buyer drops the
order" does it), and one order for several trades or sellers (Q-PUR-05: one trade = one order = one seller for now).
Dropping an order is refused while a payment waits for Accounts (409 `PAYMENT_WAITING`) or once money is received
(409 `ORDER_HAS_PAYMENT`, refunds are not built yet).

## Payments: Gate A (modules/payments)

The client's rule (Q-ACC-01): **the PO goes to the seller only when the order is paid in full; a smaller payment is
held as an advance.** Three engine actions at b6, all in `commands.ts`, with the money work in `payments.ts`:

1. **`enterPayment`** (Sales): our bank account, the UTR (spaces and dashes removed, capitals), the amount and the day
   it came in. It is saved as a `receipts` record, status LOGGED: **not money yet, nothing is posted**. Refused: a
   turned-off bank account, a future date, a UTR already live on that bank account (409 `DUPLICATE_UTR`, SRS-PAY-03),
   or more than is still open on the order (total − confirmed − entries still waiting).
2. **`confirmPayment`** (Accounts; never the person who entered it: 403, maker ≠ checker, Founder and Admin included):
   posts the RECEIPT voucher (Dr our bank · Cr the buyer, dated the day received), marks the receipt POSTED and adds it
   to the order's `paidPaise`. Paid in full → the order is PAID, the PO is raised, b6 → b7, s2 → s3. Less → an advance:
   the history says how much is still due and the trade stays at b6.
3. **`rejectPayment`** (Accounts): not found in the bank. The receipt is kept as REJECTED with the note (Sales reads it)
   and its UTR may be entered again.

Accounts works from its desk queue, **Payments to confirm**, which presses the same engine actions (one engine). The
engine lets a desk act on a trade it may press even though it cannot open the card (Accounts never sees trades).

| Call                                          | Who                                  | What it does                                                                                                   |
| --------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `GET /payments?status=&q=&page=&pageSize=`    | Accounts, Controller, Founder, Admin | The queue (default LOGGED, oldest first). Rows: buyer, order, amount, UTR, bank, `enteredByMe`, `tradeVersion` |
| `POST /payments/:id/confirm { version }`      | Accounts, Founder, Admin             | `confirmPayment` for that payment's trade (`version` = the trade's version) → `{ payment }`                    |
| `POST /payments/:id/reject { version, note }` | the same                             | `rejectPayment` → `{ payment }`                                                                                |

Payments are on the buyer side of the wall: Sales sees them on the card and the order; Purchase never sees an amount.
Not built yet: hand-added receipts (money with no order: FIFO / on account), refunds, payment reminders.

## The books (modules/books)

Double entry (LOCK-41; Q-ACC-09: **the vouchers are the only books**, no separate bank book). In short:

- **Ledger groups**: the fixed 12 (Sundry Debtors, Sundry Creditors, Bank Accounts, Sales, Purchase, Duties & Taxes,
  …). `npm run db:seed` adds them; `ledgerGroupId()` also makes one the first time it is needed.
- **Ledgers**: one per buyer (Sundry Debtors; made the first time money moves for him), one per seller (Sundry
  Creditors; made the first time the dock accepts his goods), one per bank account (Bank Accounts), and the system
  ledgers automatic postings find by key (`system`: Purchase, Input CGST/SGST/IGST, …; `systemLedger()` makes each
  the first time). A bank account IS its ledger (one bank master): the number is encrypted, only the last 4 digits
  are sent.
- **Vouchers**: one money event each: `RV-26-0001` for a receipt (Dr bank · Cr buyer), `PV-26-0001` for goods
  accepted at the dock (Dr Purchase (taxable) · Dr Input CGST + SGST, or IGST across states · Cr the seller; the
  tax split is stored in `gst`), `SV-26-0001` for a Marg bill (Dr the buyer · Cr Sales (taxable) · Cr Output CGST +
  SGST, or IGST), `PY-26-0001` for a payout (Dr the seller · Cr bank (what he is paid) · Cr Freight (what we paid
  at Indore), or Dr the buyer · Cr bank for a refund). Two or more lines, each a debit or a credit, Σ Dr =
  Σ Cr (checked by `postVoucher` and the model), one voucher per source (unique index), append-only (a mistake will be
  undone by a mirror REVERSAL voucher, later). Only `books.ts` writes vouchers.
- A ledger's balance is the sum of its voucher lines, worked out when asked (fine for TriFid's volume; a cached
  balance can come later). A bank ledger's statement is the bank book.

| Call                             | Who                                         | What it does                                                                   |
| -------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| `GET /bank-accounts?active=true` | Sales, Accounts, Controller, Founder, Admin | Our bank accounts (Sales picks one when entering a payment). No account number |
| `POST /bank-accounts`            | Founder, Admin                              | `{ name, kind, bankName, ifsc, accountNumber }` → 201. Name unique (409)       |
| `PATCH /bank-accounts/:id`       | Founder, Admin                              | `{ version, …changes, active? }`. Never deleted: turn it off                   |
| `GET /ledgers?q=`                | Accounts, Controller, Founder, Admin        | Every ledger with group, Dr and Cr totals and balance                          |
| `GET /ledgers/:id/statement`     | the same                                    | Its voucher lines, oldest first, with the running balance                      |

Not built yet: journals with approval, reversals, opening balances, bank reconciliation (instead of day close), and
the registers. The Freight ledger is credited when a seller is paid (we took the freight off his money), but the
matching debit, our own payment to the transporter, is not booked yet, so it shows a credit balance for now.

## Purchase orders (modules/purchaseOrders)

A PO (`PO-26-0001`) is raised only by `confirmPayment` when the order becomes paid in full (Gate A), in the engine's
transaction, with its audit line. One PO per sales order (unique), one seller. It copies the order's line at the
seller's landed rate (and, for an Ex listing, the Ex rate and carriage per box), the expiry and batch, and sets
`dispatchDueAt` = now + `SLA_S3_HOURS` (8). **A PO never holds the buyer or our selling rate**, so Purchase can read it.

| Call                                      | Who                                            | What it does                         |
| ----------------------------------------- | ---------------------------------------------- | ------------------------------------ |
| `GET /purchase-orders?q=&page=&pageSize=` | Purchase, Accounts, Controller, Founder, Admin | Newest first; `q` = PO no. or seller |
| `GET /purchase-orders/:id`                | the same                                       | `{ purchaseOrder }`                  |

After Gate A, Purchase presses two engine actions on the deal card (`modules/purchaseOrders/dispatch.ts`):

- **`recordDispatch`** (s3 → s5 On the way; PO `DISPATCHED`): leg 1 to Indore. `mode` TRANSPORT (transporter + LR
  number, LR date), BUS (bus details + the driver's 10-digit mobile, name) or DEPOT (a note); `freightTerms` PAID or
  TO_PAY with `freightPaise` (taken off the seller's payout later); `dispatchedOn`; and per PO line what the seller says
  he packed (`batchDeclared`, `expiryDeclared`) and `shortExpiryAgreed`. The arrival clock starts
  (`TRANSIT_OVERDUE_DAYS`, 4). No photos yet (file storage waits on Q-ARC-02).
- **`recordSellerBill`** (any time from s3 to s6; the stage does not move): `{ number, amountPaise, billDate }`. A bill
  that differs from the PO total is saved with "please check" in the history, never refused. Entering it again
  replaces it (the audit keeps the old one).

`GET /purchase-orders/:id` now also returns `leg1`, `sellerBill`, `arrival`, the latest `inspection` (per line) and the
PO's `returnNotes`. Not built yet: payouts (Q-ACC-11/12).

## The dock (modules/dock)

The Indore dock (LOCK-40 Part A, SRS-LOG-01..05). Logistics works from **Dock**: three lanes, and two engine actions
pressed with the trade's `version` (the same buttons are on the deal card for Founder and Admin):

1. **`recordArrival`** `{ arrivedAt, boxesCounted, billWithGoods }` (s5 On the way → s5 At the dock; PO `ARRIVED`):
   not in the future, not before the dispatch date. The dock should check within `INSPECTION_HOURS` (24).
2. **`inspectLot`** `{ lines: [{ lineNo, batchFound?, expiryFound?, damagedBoxes, leakingBoxes, excessBoxes }], note? }`
   (Gate B). **Short boxes are never typed**: ordered − counted, taken from the lines in PO order. Accepted = on the PO
   − short − damaged − leaking; extra boxes must add up to counted − ordered. A different batch or expiry, or less than
   `SHELF_LIFE_FLOOR_MONTHS` (6) left, is only **noted**, never a rejection (unless the short expiry was agreed). The
   outcome is the first that applies of O4 (nothing accepted), O2 (damaged/leaking), O3 (short), O5 (extra), else O1.

What the check writes, in the engine's transaction: the inspection (`inspections`, append-only: a saved check is never
changed; corrections come later, with voucher reversal); accepted > 0 → the **PURCHASE voucher** (accepted × the
seller's landed rate) and b7 → b8 To be billed, s5 → s6 Checked; damaged or leaking boxes → a REJECTED **return note**;
extra boxes → an EXCESS return note (`RTN-26-0001`, due in `RETURN_NOTE_DAYS`, 30); short, damaged and leaking boxes →
a **refund due** to the buyer (`refunds`, `REF-26-0001`, at his order's rate; paid from Payouts); nothing
accepted (O4) → no voucher, a **seller strike** (`seller_strikes`), the buyer side → Dock rejected (Sales may Reopen) and
the seller side → Closed.

| Call                                         | Who                                             | What it does                                                                                                                     |
| -------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `GET /dock?lane=COMING\|ARRIVED\|CHECKED&q=` | Logistics, Controller, Founder, Admin           | Rows: PO number, from (the seller's tehsil), lines, boxes, leg 1, days on the road, arrival, result. **No firm names, no money** |
| `POST /dock/:purchaseOrderId/arrival`        | Logistics, Founder, Admin                       | `recordArrival` for that PO's trade → `{ row }`                                                                                  |
| `POST /dock/:purchaseOrderId/inspection`     | the same                                        | `inspectLot` → `{ row }`                                                                                                         |
| `GET /return-notes?state=OPEN\|CLOSED&q=`    | Purchase, Logistics, Controller, Founder, Admin | Open ones due soonest first; each with the PO number and item                                                                    |
| `POST /return-notes/:id/close`               | Purchase, Logistics, Founder, Admin             | `{ version, how: PICKED_UP\|SHIPPED_BACK\|DISPOSED, freightPaise?, note? }`. Never written off                                   |

Refunds due are on the buyer side of the wall: the deal card (Sales) and `GET /sales-orders/:id` list them. Not built
yet: photos (Q-ARC-02), check corrections, Lost in transit (O8, Controller), the overdue jobs, the return-freight debit
to the seller. Refunds are paid from Payouts (next section).

## Marg bill (modules/billing)

Accounts keys the invoice that Marg printed for the buyer (FR-ACC-04, SRS-ACC-04). Its desk queue is **To be billed**:
orders the dock has checked (b8), oldest check first. "Enter Marg bill" presses the engine action **`recordMargBill`**
`{ version, invoiceNumber, ewayBillNumber?, billDate, totalPaise, lines: [{ lineNo, boxes }] }`. The checks, in order:

1. Already billed → 409 `ALREADY_BILLED`. A bill date in the future → 422.
2. **Check 1**: the dock accepted something (409 `MARG_CHECK_1` if not).
3. **Check 2**: per line, no more boxes than the dock accepted (422 on `lines.N.boxes`), and at least one box billed.
4. **Check 3** (Q-ACC-02, decided 26 Nov 2026): the total may not be **higher** than the accepted boxes × units per box ×
   the buyer's rate. A **lower** bill is allowed; the difference is shown (`shortByPaise`) and written in the history.
5. **Check 4**: the buyer owes nothing on the order (409 `MARG_CHECK_4`).
6. A Marg invoice number is used once (422 on `invoiceNumber`; a unique index too).

Saved in the engine's transaction: the **SALES voucher** (`SV-…`: Dr the buyer · Cr Sales (taxable) · Cr Output CGST +
SGST, or IGST across states; the tax is worked back out of the bill total with `splitGst`), the order's `margBill` and
status BILLED, and the audit line `salesOrder.margBill`. The trade stays at b8 ("Waiting for a trip"). Not built: the
"no open shortfall" check (O6 is not built), reading Marg directly (it is keyed by hand).

| Call                                         | Who                                  | What it does                                                                                      |
| -------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `GET /to-be-billed?state=TO_BILL\|BILLED&q=` | Accounts, Controller, Founder, Admin | Rows: order, buyer, tax kind, what was accepted at his rate (`accepted`), refunds due, `margBill` |
| `POST /to-be-billed/:salesOrderId/marg-bill` | Accounts, Founder, Admin             | `recordMargBill` for that order's trade (`version` = the trade's version) → `{ row }`             |

The Marg bill is on the buyer side of the wall: Sales sees it on the card and the order page; Purchase never does.

## Trips (modules/trips)

Logistics takes billed orders from the dock to the buyers (SRS-LOG-06..08). A **trip** (`T-26-0001`) is one vehicle
on one day: the vehicle number (typed, upper-cased), the driver and his mobile. It is PLANNED, then OUT (checked out),
then CLOSED (every bill has its POD). Each bill on it says how it goes on from our vehicle: `TRANSPORT` (a transport
company, named), `BUS` (a bus parcel) or `DIRECT` (we deliver). A bill is on one trip at most (a unique index).

- **Add / remove** bills only while the trip is PLANNED (409 `TRIP_NOT_PLANNED`); the trip has its own `version`
  (409 `STALE_TRIP`). Only billed orders not on a trip may be added (409 `NOT_BILLED`, `ALREADY_ON_TRIP`).
- **Check out** (needs at least one bill) keeps the **WhatsApp text** for the driver: the trip, vehicle, driver, then
  one line per bill (Marg number, boxes, destination, how to book).
- **POD** per bill, on an OUT trip: the engine action **`recordPod` `{ ref, date }`** (the LR or receipt number; not
  in the future). The buyer side → b9 Dispatched, the order DISPATCHED, and the 7-day delivery clock starts. The
  last POD closes the trip.
- Then Sales presses **Delivered** (`confirmDelivery`, b9 → b10): the order is DELIVERED.

| Call                                         | Who                                   | What it does                                                                           |
| -------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET /trips/billed?q=`                       | Logistics, Controller, Founder, Admin | Billed orders on no trip: Marg number, boxes, destination, items with batch and expiry |
| `GET /trips?status=PLANNED\|OUT\|CLOSED&q=`  | the same                              | Trips with their bills, PODs and the WhatsApp text                                     |
| `POST /trips`                                | Logistics, Founder, Admin             | `{ plannedDate, vehicleNumber, driverName, driverMobile }` → 201 `{ trip }`            |
| `POST /trips/:id/bills`                      | the same                              | `{ version, salesOrderId, bookWith: { mode, transporter? } }` → `{ trip }`             |
| `POST /trips/:id/bills/:salesOrderId/remove` | the same                              | `{ version }` → `{ trip }`                                                             |
| `POST /trips/:id/check-out`                  | the same                              | `{ version }` → `{ trip }` (OUT, WhatsApp text kept)                                   |
| `POST /trips/:id/bills/:salesOrderId/pod`    | the same                              | `{ version (the trade's), ref, date }` → `recordPod` → `{ trip }`                      |

Trips show **no firm names and no money** (Logistics sees neither). Not built yet: a vehicle register and transporter
master (typed per trip for now), photos of the POD (Q-ARC-02), and the delivery challan PDF.

## Payouts (modules/payouts)

Money going out of our bank: sellers for the goods the dock accepted, and buyers for refunds due (SRS-PAY-06..09,
LOCK-41 Part D). Decided 26 Nov 2026 (Q-ACC-03, 05, 11, 12):

1. **Build** (Accounts, Founder, Admin): pick checked POs and refunds due, and the bank account the money leaves from.
   The batch (`PAYB-26-0001`) is a **DRAFT**. Each PO or refund can be in one live batch (`payoutBatchId` on it).
2. **Release** (Founder or Admin only; the Controller looks): needs the password re-check (`requireStepUp`, 428
   `STEP_UP_REQUIRED`), and **never the person who built it** (403, maker ≠ checker, even for Founder and Admin).
   Every line becomes `PROOF_PENDING`. Releasing posts nothing and marks nothing paid.
3. **Proof** (Accounts, Founder, Admin): the bank's UTR (6 to 30 letters or digits; spaces and dashes are dropped, capitals
   kept) and the date it was paid (not in the future). **Only now is the line PAID** (Q-ACC-11, "no proof, not paid").
4. **Cancel**: only while DRAFT. The claims on the POs and refunds are let go, so they can go in another batch.

**What a seller is paid:** the accepted value (what the PURCHASE voucher credited to him) less the freight we paid at
Indore when leg 1 was `TO_PAY`. A PO is payable when it is `CHECKED`, something was accepted, **the seller's bill is on
file** (409 `NO_SELLER_BILL`) and the freight is less than the goods (422). A PO the dock rejected is 409 `NOT_PAYABLE`.

**A seller's proof** is the engine action **`recordSellerPayment`** (Accounts, s6 → Closed) with the trade's version, so
the engine's checks, history line and audit run as for every other button. In its transaction: the **PAYMENT voucher**
(`PY-26-0001`: Dr the seller (the accepted value) · Cr the bank (what he is paid) · Cr Freight), the line PAID with its
voucher number, the PO's `paidAt` (it stays CHECKED), and the seller side Closed. The buyer side is not touched.
**A refund's proof** posts Dr the buyer · Cr bank, marks the line and the refund PAID (`refund.pay` audit line).

| Call                                           | Who                                  | What it does                                                                                          |
| ---------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `GET /payouts/payables`                        | Accounts, Controller, Founder, Admin | `{ purchaseOrders, refunds }` not in a batch; a PO that cannot be batched yet says why (`waiting`)    |
| `GET /payout-batches?status&q&page&pageSize`   | the same                             | Batches, newest first (`status` DRAFT, RELEASED, CANCELLED; `q` finds a number, firm or reference)    |
| `POST /payout-batches`                         | Accounts, Founder, Admin             | `{ bankLedgerId, purchaseOrderIds, refundIds }` → 201 `{ batch }`. One bad line stops the whole batch |
| `POST /payout-batches/:id/cancel`              | the same                             | `{ version }`, DRAFT only (409 `NOT_DRAFT`, 409 `STALE_BATCH`)                                        |
| `POST /payout-batches/:id/release`             | Founder, Admin (after the step-up)   | `{ version }` → RELEASED                                                                              |
| `POST /payout-batches/:id/lines/:lineId/proof` | Accounts, Founder, Admin             | `{ utr, paidOn }`. 409 `NOT_RELEASED`, 409 `ALREADY_PAID`                                             |

Other refusals: 409 `ALREADY_IN_BATCH` (taken by another batch or already paid), 422 `bankLedgerId` (not an active
bank account). A batch names sellers and buyers, so Sales, Purchase and Logistics get 403 on all of it. What they may
read is a **line's facts**: the seller side of the deal card and `GET /purchase-orders/:id` carry `payout` (batch
number, status, amounts, UTR, date; Purchase side only), and a refund on the deal card and `GET /sales-orders/:id` has
its own `status` (DUE or PAID) and `payout` (Sales side only). A PO row carries `paidAt`.

Not built yet: payout run times (Q-ACC-06, `PAYOUT_RUN_TIMES` is not enforced), putting a seller on hold, the
return-freight debit to the seller, photos or a screenshot of the proof (Q-ARC-02), bank statement import and
reconciliation, and refunds for b6 leakage (a complaint refund is paid from here too: Build 6).

## Complaints and clocks (modules/complaints, modules/clocks)

A buyer may complain for **7 days after the proof of dispatch** (`DELIVERY_WINDOW_DAYS`). Decided 27 Nov 2026 (the
questions were open, so these are our defaults: Q-SAL-05, Q-SAL-08, Q-LOG-09):

1. **Raise** (`raiseComplaint`, Sales; Founder and Admin too). Allowed at **b9 or b10**, until `trade.complaintByAt`
   (fixed at the POD; older trades fall back to dispatch + the setting). After it: 409 `COMPLAINT_WINDOW_OVER`. It takes
   a `category` (damaged on arrival, boxes short, wrong item, quality, other), a **reason** from the reason codes
   (context `COMPLAINT`, turned on), optional `boxes` (not more than were billed) and a description. The trade goes to
   **b11 Complaint**, the Controller's clock `SLA_B11_HOURS` (48) starts, and the complaint is `CMP-26-0001`, status OPEN.
   Raised at b9, the buyer plainly has the goods, so deciding it also marks the order DELIVERED. One open complaint per
   trade at a time (b11 has no Raise button).
2. **Resolve** (`resolveComplaint`, the Controller; Founder and Admin too). The note is required and **Sales reads it**,
   so it must not name the seller. One of five outcomes (Q-SAL-05: one model):

| Outcome       | Needs  | What happens                                                                                              |
| ------------- | ------ | --------------------------------------------------------------------------------------------------------- |
| `NO_ACTION`   | note   | Recorded only: the complaint was not accepted                                                             |
| `CREDIT`      | rupees | A **credit note**: JOURNAL voucher `JV-26-0001` (Dr Sales and GST, Cr the buyer), source type `COMPLAINT` |
| `REPLACEMENT` | boxes  | Recorded only: we send new boxes (no stock moves yet)                                                     |
| `RETURN`      | boxes  | Recorded only: he sends boxes back (no stock moves yet)                                                   |
| `REFUND`      | boxes  | A **refund** row (`REF-`, `complaintId` set) at his rate × boxes, to be paid from **Payouts**             |

Caps, so the books cannot be talked into a loss: a credit or refund may not take more than the **Marg bill total**
less what earlier complaints on the order already gave back (422 `amountPaise`: "The most that can still be credited
is ₹…"), and refunded boxes may not pass the boxes billed less earlier refunded boxes (422 `boxes`). The trade goes
back to **b10**; the complaint is RESOLVED and kept. 3. **The delivery clock** (`silenceDelivery`, the system). A trade at b9 whose delivery window has run out with no
complaint is marked delivered by the server (b10, history "Delivered: no complaint came within the delivery window",
shown as "System"; audit actor role `SYSTEM`, no user id). `runClocks()` in `modules/clocks/clocks.ts` runs every
**15 minutes** from `server.ts` unless `CLOCKS_ENABLED=false`, and `POST /clocks/run` (Controller, Founder, Admin) runs
it now. It is safe to run twice: a trade that moved is skipped (409). With several server copies, set
`CLOCKS_ENABLED=true` on only one of them.

| Call                                                    | Who                               | What it does                                                        |
| ------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------- |
| `GET /complaints?status=OPEN\|RESOLVED&q&page&pageSize` | Sales, Controller, Founder, Admin | `{ counts, complaints, total, page, pageSize }` (OPEN oldest first) |
| `POST /clocks/run`                                      | Controller, Founder, Admin        | `{ delivered }`: how many trades the clock marked delivered         |

Raising and resolving are engine buttons (`POST /trades/:id/actions/raiseComplaint` and `resolveComplaint`), so the
stage, version and desk checks, the history line and the audit are the same as for every button.

**The wall.** Complaints are **buyer side only**: Sales, the Controller, Founder and Admin. Purchase, Accounts and
Logistics get 403 on `/complaints`; the deal card sent to Purchase has no `complaints` and no note, and the seller never
hears about the complaint (the history there shows only the label, "Buyer complains", without the note). The sales order
page carries `complaints` for everyone who may read the order (Accounts too).

**One real bug found on the way:** `recordSellerBill` was refused once the buyer side had moved past b8, so a late seller
bill could not be entered and the payout stayed blocked. It (and `recordSellerPayment`) now work from b8 through b11.

**Run `npm run db:sync`** once: it creates the `complaints` collection and its indexes.

Not built yet: stock for a replacement or a return (they are recorded decisions), setting a credit off against the buyer's
next order, Marg credit-note handling, the Controller's "Today" queue, and the other clocks that act by themselves (the
seller's hold running out, lost in transit, an unpaid order). The scheduler is a plain in-process timer, enough for one
server.

## Left out for now

MFA (step-up is a password re-check for now), a per-IP rate limit on login, a breached-password check, and "forgot
password" by email (an Admin resets it instead). Masters not built yet: the SKU ₹/unit matrix (P2, Q-PRC-02). Bank number: no
"reveal" action and no key rotation yet. Not enforced yet: pack label vs unit family (SRS-MST-01), making `unitsPerBox` read-only once
listings or orders use a pack, and blocking the turn-off of a tehsil or manufacturer that buyers or sellers use (parties exist now; the check is not written yet).
Parties not built yet: opening ledgers, seller KYC documents (Q-PUR-01), the bulk import of existing parties
(Q-DATA-01), placeholder parties, and automatic classification at the first order.
Listings not built yet: a daily job to expire
listings (the sweep inside the API does it for now), editing a listing, and a seller's own `/sellers/:id/listings` view.
Trades not built yet: a job that closes b1 trades nobody touched, and the clocks that should act when they run out
(only the delivery clock does).
