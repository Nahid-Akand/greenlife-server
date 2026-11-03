# AGENTS.md

## Overview
Minimal Express.js 5 HTTP server (ESM, `"type": "module"`). Single entrypoint: `index.js`. Listens on port 5001 (`PORT` env overrides). No build step — run `node index.js` directly. Deployed on Vercel.

## Routes
- `GET /` — `{message: 'GreenLife server is running'}`
- `GET /health` — `{success: true, message: 'Server is healthy'}`
- `POST /auth/register` — hash password (bcryptjs, 10 rounds), create user in MongoDB, return profile, set session
- `POST /auth/login` — verify credentials, return profile, set session
- `POST /auth/google` — verify Google ID token (`google-auth-library`), create/link account, set session (requires `GOOGLE_CLIENT_ID`)
- `GET /auth/me` — return `{authenticated, user}` from session
- `POST /auth/logout` — destroy session, clear `greenlife.sid` cookie
- `GET /events` — list events sorted by `dateTime`, with organizer info joined from `users`
- `GET /events/:id` — single event (validates `ObjectId`)
- `POST /events` — create event (`requireAuth`; validates start < end)
- `PATCH /events/:id` — update event (organizer only, `requireAuth`)
- `DELETE /events/:id` — delete event (organizer only, `requireAuth`)
- `POST /events/:id/join` — add attendee (`requireAuth`, `$addToSet`)
- `DELETE /events/:id/join` — remove attendee (`requireAuth`, `$pull`)

## Setup / commands
1. `npm install` (lockfile present; `node_modules` already installed).
2. `node index.js` — starts the server.
- `.env` exists locally but is gitignored; there is **no** `.env.example`. Keys: `MONGODB_URI`, `MONGODB_DB`, `PORT`, `GOOGLE_CLIENT_ID`, `SESSION_SECRET`, `FRONTEND_URL`. Never commit or print `.env`.
- `FRONTEND_URL` — the origin of your frontend (e.g. `https://greenlife-client.vercel.app`). Added to CORS `allowedOrigins` alongside `http://localhost:3000`. Required in Vercel for the frontend to reach the API. Sessions cookies use `sameSite: none` + `secure: true` in production, so cross-origin works only if the frontend origin is allowed by CORS.

## Vercel deployment
- No `vercel.json` present; Vercel auto-detects the Node.js project and serves `index.js`.
- Set these env vars in the Vercel project settings: `MONGODB_URI`, `MONGODB_DB`, `GOOGLE_CLIENT_ID`, `SESSION_SECRET`, `FRONTEND_URL` (must equal your Vercel frontend URL, trailing slash stripped).
- MongoDB Atlas: add Vercel's egress IPs to your Atlas **Network Access** whitelist (or temporarily `0.0.0.0/0` to test). Vercel serverless functions connect from shared, changing IPs, so Atlas may block them by default — this is the most common cause of `MongoServerSelectionError` / `tlsv1 alert internal error` in production.
- Session store uses `connect-mongo` (`MongoStore`) backed by the same `MONGODB_URI`. Sessions survive server restarts (unlike in-memory).
- In production: `secure: true`, `sameSite: "none"`, `trust proxy` enabled. The frontend must send `credentials: true` with requests.

## Verification
- `npm test` exits 1 — script is `echo "Error: no test specified" && exit 1`; no test runner configured.
- No lint, typecheck, build, formatter, or CI config exists.
- Manual smoke test: `node index.js`, then `curl http://localhost:5001/` and `curl http://localhost:5001/health`.

## Conventions / gotchas
- ESM only: `import`/`export`; no `require()`. Env loaded via `import "dotenv/config"` at top of `index.js`.
- Express **v5** (`^5.3.0`): async route handlers; route/error handling differs from v4.
- `connectToMongoDB()` caches the module-level `MongoClient` (`if (client) return client`) — not a fresh client per call. `getUsersCollection()` / `getEventsCollection()` reuse it via `getCollection()`; db defaults to `"greenlife"`.
- MongoDB is lazy: the server starts without it, but auth/event routes return 500 when the DB is unreachable. `connectToMongoDB()` now throws if `MONGODB_URI` is unset.
- `ObjectId` is imported from the `mongodb` driver (v7), not `bson`.
- Two MongoDB clients connect at runtime: one via `connectToMongoDB()` for app data, one via `MongoStore.create()` for sessions. Both use `MONGODB_URI`.
