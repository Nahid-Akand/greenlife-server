# GreenLife Server

This is the backend for GreenLife — a simple event-planning app where users can create accounts, log in with email or Google, and create/join events.

## What it does

- Lets users register and log in (email/password or Google OAuth)
- Keeps users signed in with a session cookie (`greenlife.sid`)
- Lets logged-in users create events, view events, and join or leave events they’re interested in
- Only the event organizer can edit or delete an event

## Why a separate backend

The frontend needs somewhere to store user accounts and events, verify logins, and keep sessions alive. This server handles all of that and talks to MongoDB so data persists between restarts. It’s intentionally small — one file (`index.js`), no build step — so it’s easy to run locally and quick to change.

## Which backend we use

- **Express 5** — the web framework (ESM modules, `import`/`export`)
- **MongoDB** — stores users, events, and sessions (Atlas connection string in `.env`)
- **bcryptjs** — hashes passwords before saving them
- **express-session + connect-mongo** — keeps users logged in via a `greenlife.sid` cookie; sessions stored in MongoDB so they survive restarts
- **google-auth-library** — verifies Google ID tokens for “Sign in with Google”
- **cors** — allows the frontend to send cookies and credentials

## Getting it running

```bash
npm install
node index.js
```

It starts on port `5001` (change with `PORT` in `.env`). Confirm it’s alive:

```bash
curl http://localhost:5001/
curl http://localhost:5001/health
```

You’ll need a `.env` file (it’s gitignored — don’t commit it). At minimum:

```
MONGODB_URI=<your MongoDB Atlas connection string>
MONGODB_DB=greenlife
PORT=5001
GOOGLE_CLIENT_ID=<your Google OAuth client ID>
SESSION_SECRET=<any random string>
FRONTEND_URL=http://localhost:3000
```

`SESSION_SECRET` is optional; the code falls back to a default if you leave it out. `GOOGLE_CLIENT_ID` is only needed if you want Google login to work. `FRONTEND_URL` tells CORS which frontend origin is allowed (defaults to `http://localhost:3000`).

## Routes that exist

| Method | Path | What it does |
|--------|------|--------------|
| GET | `/` | Health check — says the server is running |
| GET | `/health` | Health check — server is healthy |
| POST | `/auth/register` | Create an account with email + password |
| POST | `/auth/login` | Log in with email + password |
| POST | `/auth/google` | Sign up / log in with a Google ID token |
| GET | `/auth/me` | Check who’s logged in from the session |
| POST | `/auth/logout` | Log out and clear the session cookie |
| GET | `/events` | List all events (with organizer info) |
| GET | `/events/:id` | Get one event |
| POST | `/events` | Create an event (must be logged in) |
| PATCH | `/events/:id` | Edit an event — organizer only |
| DELETE | `/events/:id` | Delete an event — organizer only |
| POST | `/events/:id/join` | Join an event |
| DELETE | `/events/:id/join` | Leave an event |

## Deploying on Vercel

No `vercel.json` is present — Vercel auto-detects the Node.js project and serves `index.js`.

Set these env vars in the Vercel project settings:

- `MONGODB_URI` — your Atlas connection string
- `MONGODB_DB` — database name (e.g. `greenlife`)
- `GOOGLE_CLIENT_ID` — your Google OAuth client ID
- `SESSION_SECRET` — any random string
- `FRONTEND_URL` — your frontend’s Vercel URL (e.g. `https://greenlife-client-diujbsxw2-nahid13.vercel.app`, trailing slash stripped)

**MongoDB Atlas:** Vercel serverless functions connect from shared, changing IPs. Add Vercel’s egress IPs to your Atlas **Network Access** whitelist (or temporarily `0.0.0.0/0` to test). This is the most common cause of `MongoServerSelectionError` / `tlsv1 alert internal error` in production.

In production the session cookie uses `secure: true` and `sameSite: "none"`, so the frontend must send `credentials: true` with its requests and the frontend origin must be listed in `FRONTEND_URL`.

## Things to know

- No build step — just run `node index.js`.
- No tests configured (`npm test` does nothing useful right now).
- MongoDB connects lazily: the server starts even if the database is down, but any route that needs the database will fail.
- CORS accepts `http://localhost:3000` plus whatever you set in `FRONTEND_URL`.
- Two MongoDB clients connect at runtime: one for app data, one for sessions. Both use `MONGODB_URI`.
