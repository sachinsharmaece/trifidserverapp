# trifid-serverapp

Node.js, Express, TypeScript, MongoDB, and Mongoose foundation for TriFid.

## Setup

```bash
npm install
copy .env.example .env
```

Start a local MongoDB instance, then run `npm run dev`. The server exposes `GET /health`.

## Scripts

- `npm run dev` starts the TypeScript development server.
- `npm run build` compiles to `dist`.
- `npm run lint` runs ESLint.
- `npm run format:check` checks Prettier formatting.
- `npm run typecheck` runs TypeScript without emitting files.
