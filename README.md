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

| Script                   | What it does                      |
| ------------------------ | --------------------------------- |
| `npm run dev`            | Start with auto-reload (tsx)      |
| `npm run typecheck`      | TypeScript check, no output files |
| `npm run build`          | Compile to `dist/`                |
| `npm start`              | Run the compiled build            |
| `npm run lint`           | ESLint (`lint:fix` fixes some)    |
| `npm run db:sync`        | Create collections + indexes      |
| `npm run db:seed`        | Add default settings (safe rerun) |
| `npm run create-founder` | Create the first Founder account  |
| `npm run format`         | Prettier (`format:check` reports) |

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

| Area     | Collections                                                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| System   | `users`, `sessions` (TTL), `counters`, `idempotency_keys` (TTL 72 h), `audit_events` (append-only), `settings`                         |
| Masters  | `company` (single document), `manufacturers`, `technicals`, `hsn_codes`, `products`, `skus`, `tehsils`, `reason_codes`, `margin_cells` |
| Parties  | `sellers`, `buyers` (each party's dealerships are kept on the party itself)                                                            |
| Listings | `listings` (a seller's offer of one pack)                                                                                              |
| Not yet  | orders, trades, books (vouchers/ledgers), dock, trips (ARCH §B3.4–B3.7)                                                                |

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
  scripts/             db-sync.ts, db-seed.ts (run with npm run db:sync / db:seed)
  middleware/          requestId (more later: idempotency)
  routes/index.ts      the /api/v1 router — mount feature modules here
  modules/<feature>/   one folder per feature (health, auth, users, masters, parties, listings today)
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

Everyone signed in can read; only Founder and Admin can change (`canEditMasters` in `permissions.ts`). Nothing is
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

## Parties (modules/parties)

Sellers (who we buy from) and buyers (who we sell to). The visibility wall is enforced here: `/sellers` is for Purchase,
Controller, Founder and Admin; `/buyers` is for Sales, Controller, Founder and Admin; any other role gets 403
(`modules/parties/permissions.ts`). Admin on both sides follows the open question Q-ROL-01: change it in that one file.

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

## Left out for now

MFA, step-up re-authentication, a per-IP rate limit on login, a breached-password check, and "forgot password" by
email (an Admin resets it instead). Masters not built yet: the margin matrix (needs step-up). Bank number: no
"reveal" action and no key rotation yet. Not enforced yet: pack label vs unit family (SRS-MST-01), making `unitsPerBox` read-only once
listings or orders use a pack, and blocking the turn-off of a tehsil or manufacturer that buyers or sellers use (parties exist now; the check is not written yet).
Parties not built yet: opening ledgers, seller KYC documents (Q-PUR-01), the bulk import of existing parties
(Q-DATA-01), placeholder parties, and automatic classification at the first order.
Listings not built yet: the Sales-side rate board and selling prices (they need the margin matrix), a daily job to expire
listings (the sweep inside the API does it for now), editing a listing, and a seller's own `/sellers/:id/listings` view.
