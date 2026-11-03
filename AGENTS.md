# AGENTS.md

## Overview
Minimal Express.js 5 HTTP server (ESM, `"type": "module"`). Single entrypoint: `index.js`. Listens on port 5001 (`PORT` env overrides). CORS allows `http://localhost:3000` with `credentials: true`. No build step — run `node index.js` directly.

## Routes
- `GET /` — `{message: 'GreenLife server is running'}`
- `POST /auth/register` — hash password (bcryptjs, 10 rounds), create user in MongoDB, return profile, set session
- `POST /auth/login` — verify credentials, return profile, set session
- `POST /auth/google` — verify Google ID token (`google-auth-library`), create/link account, set session (requires `GOOGLE_CLIENT_ID`)
- `GET /auth/me` — return `{authenticated, user}` from session
- `POST /auth/logout` — destroy session, clear `connect.sid` cookie
- `GET /events` — list events sorted by `dateTime`, with organizer info joined from `users`
- `GET /events/:id` — single event (validates `ObjectId`)
- `POST /events` — create event (`requireAuth`; validates start < end)
- `PATCH /events/:id` — update event (organizer only, `requireAuth`)
- `DELETE /events/:id` — delete event (organizer only, `requireAuth`)
- `POST /events/:id/join` — add attendee (`requireAuth`, `$addToSet`)
- `DELETE /events/:id/join` — remove attendee (`requireAuth`, `$pull`)

`GET /events` is registered twice in `index.js`; Express uses the first match, so the second definition (sorted by `createdAt`, no organizers) is unreachable dead code.

## Setup / commands
1. `npm install` (lockfile present; `node_modules` already installed).
2. `node index.js` — starts the server.
- `.env` exists locally but is gitignored; there is **no** `.env.example`. Keys: `MONGODB_URI`, `MONGODB_DB`, `PORT`, `GOOGLE_CLIENT_ID`, `SESSION_SECRET`. It contains a real Atlas connection string — never commit or print it. `SESSION_SECRET` is optional; code falls back to `"dev-secret-change-me"` when unset or empty.
- `connect-mongo` is installed but **not** wired up; session store is in-memory (`express-session` default). Cookie: `httpOnly`, `sameSite: lax`, `secure: false`, 24h maxAge — dev only.

## Verification
- `npm test` exits 1 — script is `echo "Error: no test specified" && exit 1`; no test runner configured.
- No lint, typecheck, build, formatter, or CI config exists.
- Manual smoke test: `node index.js`, then `curl http://localhost:5001/`.

## Conventions / gotchas
- ESM only: `import`/`export`; no `require()`. Env loaded via `import "dotenv/config"` at top of `index.js`.
- Express **v5** (`^5.3.0`): async route handlers; route/error handling differs from v4.
- `connectToMongoDB()` caches the module-level `MongoClient` (`if (client) return client`) — it is **not** a fresh client per call. `getUsersCollection()` / `getEventsCollection()` reuse it; db defaults to `"greenlife"`.
- MongoDB is lazy: the server starts without it, but auth/event routes return 500 when the DB is unreachable.
- `ObjectId` is imported from the `mongodb` driver (v7), not `bson`.
