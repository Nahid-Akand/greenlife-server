# GreenLife Server

This is the backend for GreenLife — a simple event-planning app where users can create accounts, log in with email or Google, and create/join events.

## What it does

- Lets users register and log in (email/password or Google OAuth)
- Keeps users signed in with a session cookie
- Lets logged-in users create events, view events, and join or leave events they’re interested in
- Only the event organizer can edit or delete an event

## Why a separate backend

The frontend (running on `localhost:3000`) needs somewhere to store user accounts and events, verify logins, and keep sessions alive. This server handles all of that and talks to MongoDB so data persists between restarts. It’s intentionally small — one file (`index.js`), no build step — so it’s easy to run locally and quick to change.

## Which backend we use

- **Express 5** — the web framework (ESM modules, `import`/`export`)
- **MongoDB** — stores users and events (Atlas connection string in `.env`)
- **bcryptjs** — hashes passwords before saving them
- **express-session** — keeps users logged in via a `connect.sid` cookie
- **google-auth-library** — verifies Google ID tokens for “Sign in with Google”
- **cors** — allows the frontend at `http://localhost:3000` to send cookies/credentials

## Getting it running

```bash
npm install
node index.js
```

It starts on port `5001` (change with `PORT` in `.env`). Open `http://localhost:5001/` in your browser or hit it with `curl` to confirm it’s alive:

```bash
curl http://localhost:5001/
```

You’ll need a `.env` file (it’s gitignored — don’t commit it). At minimum:

```
MONGODB_URI=<your MongoDB Atlas connection string>
MONGODB_DB=greenlife
PORT=5001
GOOGLE_CLIENT_ID=<your Google OAuth client ID>
SESSION_SECRET=<any random string>
```

`SESSION_SECRET` is optional; the code falls back to a default if you leave it out. `GOOGLE_CLIENT_ID` is only needed if you want Google login to work.

## Routes that exist

| Method | Path | What it does |
|--------|------|--------------|
| GET | `/` | Health check — says the server is running |
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

## Things to know


- MongoDB connects lazily: the server starts even if the database is down,
- CORS is locked to `http://localhost:3000` with credentials enabled, so it works with the dev frontend out of the box.
