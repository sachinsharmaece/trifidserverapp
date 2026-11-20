# trifidserverapp

TriFid back-office API: Express 5, MongoDB (Mongoose 9), TypeScript, Zod.

## Run it

```powershell
npm install
copy .env.example .env      # then set MONGODB_URI (must be a replica set, e.g. MongoDB Atlas)
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
  modules/<feature>/   one folder per feature (health, auth, users today)
  shared/              errors (HttpError + error envelope), logger, shutdown, enums, validators
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

## Left out for now

MFA, step-up re-authentication, a per-IP rate limit on login, a breached-password check, and "forgot password" by
email (an Admin resets it instead).
