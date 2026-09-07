# trifid-serverapp

Node.js, Express, TypeScript, MongoDB and Mongoose. The API and the worker for TriFid.

Business rules, the data model, the API contract and every decision behind this code live in the
SSOT (`trifid-docs` / `trifid-ssot`), not here — start there, not in this file, when in doubt.

## Setup

```bash
npm install
copy .env.example .env
```

MongoDB **must run as a replica set** — a standalone server is refused at startup with an
explanation (see `src/db/connect.ts`). A single-node replica set is fine for development, and so is
a MongoDB Atlas cluster (Atlas clusters are always replica sets).

```bash
npm run dev          # the API server, http://localhost:4000
npm run worker:dev    # the worker process, separate from the API (CH §25.2)
npm run seed:admin    # one-time: creates the first Admin (QR-028). Refuses to run twice.
```

## Scripts

- `npm run dev` / `npm run worker` / `npm run worker:dev` — start the server / worker.
- `npm run build` — compile to `dist`.
- `npm run seed:admin` — the one-time first-Admin seed.
- `npm run check:dead-list` — fails if a `CH §23.5` dead-list name appears under `src/models/`.
- `npm run lint` / `npm run format` / `npm run format:check` — ESLint / Prettier.
- `npm run typecheck` (alias `type-check`) — `tsc --noEmit`.
- `npm test` — dead-list check, then the full Vitest suite against a real in-memory MongoDB
  replica set (`mongodb-memory-server`), not a mock.

## Layout

`src/config` env and permission constants · `src/db` connection, transaction helper, role seeding ·
`src/models` one file per collection · `src/modules` one folder per business area
(`routes`/`controller`/`service`/`validation`) · `src/middleware` auth, permission, ownership,
reauth, validation, rate limiting · `src/shared` errors, money, clock, logger, audit, the
audience-DTO wall · `src/worker` the separate background process · `src/scripts` one-off scripts ·
`tests/` — see `tests/setup.ts` for how the replica set is started per test run.
