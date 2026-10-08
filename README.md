# Mailcheck

Email verification web app. Phase 1: accounts, credit ledger, manual credit top-ups, single email check.

## Run locally
1. Install Node.js 22 LTS from https://nodejs.org
2. `npm install`
3. Copy `.env.example` to `.env` and fill it in
4. `npm run dev`
5. Open http://localhost:3000

## Folders
- `src/server.js`   routes (signup, login, verify, admin grant)
- `src/db.js`       database tables
- `src/credits.js`  credit ledger (balance = sum of rows)
- `src/providers/`  the only code that talks to the verification provider
- `public/`         the web page

## Rules
- Never commit `.env` (it holds your provider key).
- Keep MOCK_PROVIDER=1 until the provider response format is implemented in `normalize()`.
