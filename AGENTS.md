# AGENTS.md

## Overview
Minimal Express.js 5 HTTP server (ESM, `"type": "module"`). Single entrypoint: `index.js`. Listens on port 5001 (overridable via `PORT` env).

Routes:
- `GET /` — `{message: 'server is running'}`
- `POST /auth/register` — hash password, create user in MongoDB, return profile, set session
- `POST /auth/login` — verify credentials, return profile, set session
- `POST /auth/logout` — destroy session, clear `connect.sid` cookie
- `export async function connectToMongoDB()` — lazy MongoDB connection (server starts without it)

CORS is enabled for `http://localhost:3000` with `credentials: true`.

## Setup / commands
1. `npm install` (lockfile present; `node_modules` already installed).
2. `node index.js` — starts the server.

- `.env` already exists locally with `MONGODB_URI`, `MONGODB_DB`, `PORT`. There is **no** `.env.example`. It contains a real Atlas connection string — never commit or print it.
- `SESSION_SECRET` is not set in `.env`; code falls back to the hardcoded `"dev-secret-change-me"`.
- Without a reachable MongoDB, auth routes return 500. The server itself still starts.

## Verification
- `npm test` exits with error by default — no test runner is configured.
- No lint, typecheck, build, formatter, or CI config exists. Do not invent or assume any.
- Manual smoke test: `node index.js`, then `curl localhost:5001/`.

## Dependencies
`express` (v5), `mongodb`, `dotenv`, `cors`, `bcryptjs`, `express-session`.

## Conventions / gotchas
- ESM only: use `import`/`export`, not `require()`. Env is loaded via `import "dotenv/config"` at top of `index.js`.
- Express is **v5** — async handler errors and route syntax differ from v4.
- `getUsersCollection()` calls `connectToMongoDB()` on **every request** — a fresh `MongoClient` per auth call, no pooling/caching. Preserve or improve this intentionally.
- Session store is in-memory (`express-session` default); cookie is `httpOnly`, `sameSite: lax`, `secure: false`, 24h maxAge — fine for dev, not production.
