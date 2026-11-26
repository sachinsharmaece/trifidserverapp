# trifidserverapp (API)

Workspace rules and the server ↔ admin-app contract are in `../CLAUDE.md` (loaded automatically).
Full commands and folder layout: `README.md`.

## Commands

`npm run dev` (port 4000) · `npm run typecheck` · `npm run lint` · `npm run format:check` · `npm run build`
`npm run db:sync` (collections + indexes) · `npm run db:seed` (default settings; never overwrites) ·
`npm run db:seed-demo` (made-up margins for development; refuses production) ·
`npm run create-founder` (first Founder account; asks for the password, shows nothing while typing).
MongoDB must be a replica set (transactions). `.env` holds secrets: never print, commit or edit it.

## Where code goes

- `src/models/<name>.model.ts`: one Mongoose model per collection, exported from `src/models/index.ts`.
  Use ARCH §B1/§B3 for collection and field names, but only the fields the current feature needs. Reuse `intField`,
  `bpField`, `refField`, `textField` from `src/models/_fields.ts`. Enums only from `src/shared/enums.ts`.
- `src/modules/<feature>/`: routes, Zod request schemas, service code for one feature. Mount in `src/routes/index.ts`.
- `src/shared/`: errors (`HttpError`, `badRequest`, `notFound`, …), logger, validators, enums.
- `src/db/`: connection, `nextDocumentNumber()`, seeds. `src/scripts/`: one-off CLI scripts.

## Conventions

- Protect a route with `requireAuth` (`src/modules/auth/requireAuth.ts`); it sets `req.user`. Limit it to roles with
  `requireRole('ADMIN', …)` placed after it, e.g. `router.use('/users', requireAuth, requireRole('FOUNDER', 'ADMIN'))`.
  Read the person with `currentUserOf(req)`.
- Record who changed what with `writeAudit(req, {...})` and `onlyChanged(before, after)` (`src/shared/audit.ts`). Turn a
  unique-index clash into a 409 with `.catch(failIfDuplicate(message, code))` (`src/shared/mongo.ts`). Master data
  (`src/modules/masters/`): reads need `requireAuth`, writes add `canEditMasters`; change a document with
  `doc.set(...)` then `doc.save()` so the lower-case name hook runs.
- Parties live in `src/modules/parties/`: the role wall is `permissions.ts` (`canUseSellers`, `canUseBuyers`), shared
  request pieces are in `common.ts`. Party numbers come from `nextPartyNumber()`. To find a duplicate bank account use
  `hashText()` (a fingerprint); never decrypt numbers to compare them.
- Listings live in `src/modules/listings/`: the wall is `canUseListings` (same file as the party walls), the rate maths is
  in `rates.ts` (`landedRate`, `dropExceeds`, `dedupeKeyOf`), and `expireOldListings()` runs at the start of each listings
  request (there is no scheduler yet). Read a number setting with `numberSetting(key, fallback)` (`src/db/settings.ts`).
  A listing is never edited, only paused, resumed or withdrawn.
- Buyer-facing rates come from `computeBuyerRate()` in `src/modules/pricing/pricing.ts`, and from nowhere else: never
  repeat the margin sum in another file. The Sales rate board (`pricing/board.routes.ts`, `GET /buyers/:id/board`) sits on
  the buyer side of the wall: build its response from buyer-safe fields only, never copy a listing or a margin into it.
- Trades live in `src/modules/trades/` and only `engine.ts` writes `trades` and `trade_events` (Q-WF-01, one engine).
  A new button is a row in `actions.ts` plus a handler in `commands.ts`; never a new route that writes a trade. What a
  role may see of a trade is decided in `view.ts` only. Every action needs the trade's `version` (409 `STALE_TRADE`).
- Sales orders live in `src/modules/salesOrders/`: raised and cancelled only from inside an engine command
  (`raiseSalesOrder`, `cancelSalesOrder`, in the command's `session`); the routes only read. GST is always worked out
  with `splitGst()` (`src/shared/money.ts`), never by hand.
- Money and the books: payments (`src/modules/payments/`) and POs (`src/modules/purchaseOrders/`) are written only from
  inside engine commands. Vouchers are written only by `postVoucher()` in `src/modules/books/books.ts` (balanced,
  append-only). Maker ≠ checker: the person who enters a payment never confirms it. A PO never holds buyer data.
- Margins live in `src/modules/masters/marginCells.routes.ts`: reading needs `canSeeMargins` (the wall), writing adds
  `canEditMasters` and `requireStepUp` (`src/modules/auth/stepUp.ts`, 428 until the password was re-checked in the last 5
  minutes). Use `requireStepUp` after the role check on any route that should ask for the password again. A cell is
  never edited: add a new one with a later `effectiveFrom`.
- Throw `HttpError` helpers; never `res.status(...).json({ error })` by hand. Zod errors become 422 automatically.
- Validate every request with Zod. Never trust ids, money or roles from the client.
- Money writes and the audit/voucher entries that go with them happen in ONE MongoDB transaction.
- `margin_cells`, `audit_events`, `trade_events` and `vouchers` cannot be changed after insert (append-only). Other collections use Mongoose
  defaults; add optimistic locking (`version`) only to documents several people edit at once (orders, trades).
- `select: false` and a `toJSON` transform for secrets (`passwordHash`, encrypted bank numbers). Bank numbers are locked
  with `encryptText()` (`src/shared/encryption.ts`); return only `accountLast4`, never the number or the locked text.
- Mongoose 9: pre hooks are async or throw (no `next`); use `doc.validate()`, not the deprecated `validateSync()`.
- Keep TypeScript on 5.9.x (typescript-eslint does not support 7). No new dependency without saying why.
