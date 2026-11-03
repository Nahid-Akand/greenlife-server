# AGENTS.md

## Overview
Minimal Express.js 5 HTTP server (ESM, `"type": "module"`). Single entrypoint: `index.js`. Exports the Express app as default; only calls `app.listen()` when `NETLIFY` env is not `"true"` (local dev on port 5001). Deployed on Netlify as a serverless function wrapped with `serverless-http`.

## Netlify wiring (required)
- `netlify.toml` — sets `functions = "netlify/functions"` and redirects `/*` to `/.netlify/functions/api/:splat` (status 200).
- `netlify/functions/api.js` — imports `app` from `index.js` and wraps it with `serverless-http`, exporting `handler`.
- Build command: `npm install` (installs deps; no build output needed since functions are the deployable artifact).

## Routes
- `GET /` — `{message: 'GreenLife server is running'}`
- `GET /health` — `{success: true, message: 'Server is healthy'}`
- `POST /auth/register` — hash password (bcryptjs, 12 rounds), create user in MongoDB, return profile, set session
- `POST /auth/login` — verify credentials, return profile, set session
- `POST /auth/google` — verify Google ID token (`google-auth-library`), create/link account, set session (requires `GOOGLE_CLIENT_ID`)
- `GET /auth/me` — return `{authenticated, user}` from session
- `POST /auth/logout` — destroy session, clear `greenlife.sid` cookie
- `GET /events` — list events sorted by `createdAt`, with organizer info joined from `users`
- `GET /events/:id` — single event (validates `ObjectId`)
- `POST /events` — create event (`requireAuth`)
- `PATCH /events/:id` — update event (organizer only, `requireAuth`)
- `DELETE /events/:id` — delete event (organizer only, `requireAuth`)
- `POST /events/:id/join` — add attendee (`requireAuth`, `$addToSet` on `participants`)
- `DELETE /events/:id/join` — remove attendee (`requireAuth`, `$pull` on `participants`)

## Setup / commands
1. `npm install` (lockfile present; `node_modules` already installed).
2. `node index.js` — starts the server locally on port 5001 (skipped on Netlify).
- `.env` exists locally but is gitignored; there is **no** `.env.example`. Keys: `MONGODB_URI`, `MONGODB_DB`, `PORT`, `GOOGLE_CLIENT_ID`, `SESSION_SECRET`, `FRONTEND_URL`. Never commit or print `.env`.
- `FRONTEND_URL` — the origin of your frontend (e.g. `https://greenlife-client.netlify.app`). Added to CORS `allowedOrigins` alongside `http://localhost:3000`. Required in Netlify for the frontend to reach the API. Sessions cookies use `sameSite: none` + `secure: true` in production, so cross-origin works only if the frontend origin is allowed by CORS.

## Netlify deployment
- No `vercel.json`; this project is configured for Netlify via `netlify.toml`.
- Set these env vars in Netlify project settings: `MONGODB_URI`, `MONGODB_DB`, `GOOGLE_CLIENT_ID`, `SESSION_SECRET`, `FRONTEND_URL` (must equal your Netlify frontend URL, trailing slash stripped).
- MongoDB Atlas: add Netlify's egress IPs to your Atlas **Network Access** whitelist (or temporarily `0.0.0.0/0` to test). Netlify serverless functions connect from shared IPs, so Atlas may block them by default — this is the most common cause of `MongoServerSelectionError` / SSL errors in production.
- Session store uses `connect-mongo` (`MongoStore`) backed by the same `MONGODB_URI`. Sessions survive function invocations.
- In production: `secure: true`, `sameSite: "none"`, `trust proxy` enabled. The frontend must send `credentials: true` with requests.

## Verification
- `npm test` exits 1 — script is `echo "Error: no test specified" && exit 1`; no test runner configured.
- No lint, typecheck, build, formatter, or CI config exists.
- Manual smoke test: `node index.js`, then `curl http://localhost:5001/` and `curl http://localhost:5001/health`.

## Conventions / gotchas
- ESM only: `import`/`export`; no `require()`. Env loaded via `import "dotenv/config"` at top of `index.js`.
- Express **v5** (`^5.3.0`): async route handlers; route/error handling differs from v4.
- `connectToMongoDB()` caches the module-level `MongoClient` (`if (client) return client`) — not a fresh client per call. `getUsersCollection()` / `getEventsCollection()` reuse it via `getCollection()`; db defaults to `"greenlife"`.
- MongoDB is lazy: the server starts without it, but auth/event routes return 500 when the DB is unreachable. `connectToMongoDB()` throws if `MONGODB_URI` is unset.
- `ObjectId` is imported from the `mongodb` driver (v7), not `bson`.
- Two MongoDB clients connect at runtime: one via `connectToMongoDB()` for app data, one via `MongoStore.create()` for sessions. Both use `MONGODB_URI`.
- `app.listen()` is skipped when `NETLIFY === "true"`; the function handler in `netlify/functions/api.js` serves requests instead.
