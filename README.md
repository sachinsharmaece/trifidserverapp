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

| Area    | Collections                                                                                                                            |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| System  | `users`, `sessions` (TTL), `counters`, `idempotency_keys` (TTL 72 h), `audit_events` (append-only), `settings`                         |
| Masters | `company` (single document), `manufacturers`, `technicals`, `hsn_codes`, `products`, `skus`, `tehsils`, `reason_codes`, `margin_cells` |
| Not yet | parties, listings, orders, trades, books (vouchers/ledgers), dock, trips (ARCH §B3.3–B3.7)                                             |

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
  modules/<feature>/   one folder per feature (health, auth, users, masters today)
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
| `GET /tehsils?q=&page=&pageSize=`                     | `{ tehsils, total, page, pageSize }`; `q` is a 6-digit pincode, or part of the state / district / tehsil name; sorted by state, district, name                                                |
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

## Left out for now

MFA, step-up re-authentication, a per-IP rate limit on login, a breached-password check, and "forgot password" by
email (an Admin resets it instead). Masters not built yet: the margin matrix (needs step-up). Bank number: no
"reveal" action and no key rotation yet. Not enforced yet: pack label vs unit family (SRS-MST-01), making `unitsPerBox` read-only once
listings or orders use a pack, and blocking a tehsil's turn-off while buyers or sellers use it (there are no parties yet).
