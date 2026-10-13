# Mailcheck

Email verification web app. Phase 1: accounts, credit ledger, manual credit top-ups, single email check.

## Folders
- `src/server.js`   routes (signup, login, verify, admin grant)
- `src/db.js`       database tables
- `src/credits.js`  credit ledger (balance = sum of rows)
- `src/providers/`  the only code that talks to the verification provider
- `public/`         the web page