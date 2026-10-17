# Mailcheck

A small web app for email verification, sold by credits. Customers log in, buy credits with crypto (USDT on TRON), and check single addresses or upload files for batch checking.

Everything that talks to the verification providers runs on the server. The browser only ever talks to this app's own `/api/...` routes, so provider URLs, accounts and keys are never sent to a visitor.

## Features

- **Single check**: verify one address for 1 credit. Refunded automatically if the provider can't give an answer.
- **Batch check**: upload a CSV or text file. Credits are reserved up front, and anything not verified (errors, unknown results, wrong-format rows) is refunded when the job ends.
- **Credits ledger**: every credit added or spent is a row in `credit_ledger`. A balance is the sum of the rows.
- **Result cache**: definitive results are reused for `CACHE_DAYS` days, so repeat checks cost nothing extra.
- **Crypto payments**: USDT (TRC-20) with a unique amount per order, confirmed automatically by watching your wallet.
- **Accounts**: created by you only (no public signup). Optional admin accounts can grant credits.
- **Automatic cleanup and backups**: old jobs, history and orders are purged on a schedule, and the database is backed up daily.

## Requirements

- Node.js 22 or newer (the app uses `node --env-file` and `--watch`)
- A provider account for single checks and one for bulk checks
- For real payments: a TRON wallet address that can receive USDT

## Setup

```
npm install
```

Create a `.env` file in the project root (see the reference below), then start the app:

```
npm run dev
```

The site is at `http://localhost:3000`.

Create your first account from the command line (see "Creating users").

## Configuration (`.env`)

Never commit `.env`. It is listed in `.gitignore`.

### Core

| Variable | Description |
| --- | --- |
| `PORT` | Port to listen on. Default `3000`. |
| `JWT_SECRET` | Random string, at least 32 characters. The app refuses to start without it. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Changing it logs everyone out. |
| `ADMIN_KEY` | Random string, at least 24 characters. Protects the create-user page. If unset, that page's endpoint is disabled. |
| `NODE_ENV` | Set to `production` when live. The login cookie is then `secure`, which needs HTTPS. |
| `DB_PATH` | SQLite file path. Default `data.db`. |
| `MOCK_PROVIDER` | `1` fakes both providers for local testing. `0` uses the real ones. |

### Providers

| Variable | Description |
| --- | --- |
| `PROVIDER_API_BASE` | Base URL of the single-check provider. |
| `PROVIDER_KEY` | API key for single checks. |
| `PROVIDER_MAX_PER_MIN` | Throttle for single checks. Default `600`. |
| `BULK_API_BASE` | Base URL of the bulk provider. Use `https://` if they support it. |
| `BULK_ACCOUNT`, `BULK_PASS` | Bulk provider login. |
| `BULK_TYPE_FB` | Bulk provider type ID used for uploads. |
| `BULK_COUNTRY_CODE` | Country code sent with uploads. Default `1`. |
| `BULK_MIN_PER_FILE` | Minimum addresses per file the provider accepts. Default `2001`. |
| `BULK_MAX_PER_FILE` | Maximum addresses per file sent to the provider. Default `50000`. |
| `BULK_POLL_SECONDS` | How often to ask the provider about a running batch. Default `15`. |
| `BULK_MAX_WAIT_HOURS` | Give up on a batch after this long. Default `6`. |
| `BULK_COST_PER_EMAIL` | If above 0, the worker pauses when the provider balance is too low. Default `0` (off). |
| `MAX_JOB_EMAILS` | Maximum addresses per uploaded file. Default `100000`. |
| `CACHE_DAYS` | How long results are cached. `0` turns caching off. Default `30`. |
| `LOG_PROVIDER_RAW` | `1` prints raw provider responses to the console. Use only while debugging; turn off in production. |

### Payments

| Variable | Description |
| --- | --- |
| `PAYMENT_PROVIDER` | `tron` for real USDT payments, `test` for instant fake credits (development only). |
| `TRON_ADDRESS` | Your receiving wallet address (starts with `T`, 34 characters). Public address only. Never put a seed phrase or private key anywhere in this project. |
| `ORDER_EXPIRY_MINUTES` | How long a payment request stays open. Default `30`. |
| `TRONGRID_API_KEY` | Optional free key from trongrid.io. Add it if you see `trongrid_http_429` in the console. |
| `LOG_PAYMENT_RAW` | `1` prints what the blockchain API returns. For debugging. |
| `ALLOW_TEST_PAYMENTS` | `1` allows test-mode payments when `NODE_ENV=production`. Leave unset. |

### Housekeeping

| Variable | Description |
| --- | --- |
| `JOB_RETENTION_DAYS` | Finished batch jobs and their results are deleted after this many days. Default `7`. |
| `HISTORY_RETENTION_DAYS` | Single-check history, orders and credit activity are deleted after this many days. Default `30`. Credit balances are not affected. |
| `BACKUP_DIR` | Where daily backups go. Default `backups`. Never inside `public/`. |
| `BACKUP_KEEP` | How many daily backups to keep. Default `7`. |

## Project layout

```
mailcheck/
  admin/                  create-user page (served only at /manage-users)
  public/index.html       the customer-facing site
  src/
    server.js             routes, login, startup checks
    worker.js             batch job processing and refunds
    jobRoutes.js          upload, list, cancel, download
    billing.js            orders and fulfilment
    billingRoutes.js      plans, purchase, order status
    payments.js           payment mode switch
    paymentWatcher.js     watches the wallet for USDT payments
    plans.js              credit packages
    credits.js            ledger balance, add, spend
    csv.js                CSV parsing and email extraction
    db.js                 SQLite schema and migrations
    retention.js          scheduled cleanup
    backup.js             scheduled backups
    createUser.js         command-line account creation
    providers/
      mailVerifier.js     single-check provider
      bulkVerifier.js     bulk provider
  data.db                 the database (not committed)
  backups/                daily copies (not committed)
```

## Creating users

There is no public signup. Accounts are created by you in one of two ways.

**Command line (recommended).** Run from the project folder. Wrap the password in quotes.

```
node --env-file=.env src/createUser.js john "StrongPass123"
node --env-file=.env src/createUser.js myadmin "AnotherPass456" --admin
```

**Create-user page.** Open `/manage-users`, enter your `ADMIN_KEY`, a username and a password. This page can only create normal accounts, never admins. Without the correct key the endpoint returns 404, and it is rate limited.

Usernames are stored lowercase in the `users.email` column (the column name is historical).

An admin sees a "Customer credit management" box in the Profile tab and can add or remove credits for any username.

## How payments work

1. The customer picks a package or a custom amount.
2. The server creates an order with a unique amount, for example `100.0381` USDT, and shows it with your address and a QR code.
3. Every 15 seconds, while any order is pending, the watcher asks TronGrid for confirmed incoming USDT transfers to your address.
4. A transfer that matches an open order's exact amount, inside its time window, with a transaction ID not used before, marks the order paid and adds the credits.

Notes:

- The customer pays up to about 10 cents more than the price because of the unique tag. Credits are based on the price.
- The amount must match to the last digit. Exchanges that deduct a withdrawal fee from the amount sent will cause a mismatch.
- A customer can have at most 3 unpaid orders open. Unpaid orders expire after `ORDER_EXPIRY_MINUTES`, plus 10 minutes of grace for confirmation delay.
- When nothing is pending, the watcher makes no external requests.

### Approving a payment by hand

If a customer mistypes the amount or a payment doesn't match:

1. Ask for the transaction hash and find it on tronscan.org. Confirm the recipient is your wallet, the token is USDT (TRC-20), the status is confirmed, and the amount is right.
2. Confirm the hash isn't already used: `SELECT id FROM orders WHERE tx_id = 'HASH';` should return nothing.
3. Approve the order:

```
node --env-file=.env src/approveOrder.js <orderId> <txHash> [credits]
```

Use `-` instead of a hash if you don't have one. The optional last value is the number of credits to give if they paid a different amount than ordered.

If the customer paid but never created an order, add credits with the admin tool in the Profile tab instead.

## Working with the database

The database is a single SQLite file (`data.db`, plus `-shm` and `-wal` files while running). Open it with DB Browser for SQLite or the SQLite Viewer extension for VS Code.

- Copy `data.db` before editing anything, and press Write Changes when you finish so the lock is released.
- Don't edit or delete old `credit_ledger` rows. To change a balance, add a new row (use the admin tool).
- Don't edit `password_hash` by hand. It stores a bcrypt hash.
- To restore a backup: stop the app, replace `data.db` with the backup, delete the leftover `data.db-shm` and `data.db-wal` files, and start again.

## Security notes

- Never commit `.env`, `data.db`, or `backups/`. If a secret was ever committed or pasted somewhere public, rotate it.
- Use HTTPS in production. Without it the secure session cookie won't be kept, and the login and admin key travel unencrypted.
- Never send provider error messages to the browser. Provider errors are only logged on the server; keep it that way.
- Keep `.env`, backups and any new files outside `public/`. Everything in `public/` is served to anyone.
- Set `app.set('trust proxy', 1)` in `server.js` only if a reverse proxy or tunnel (nginx, Cloudflare, ngrok and similar) sits in front of the app. Otherwise leave it out.
- Turn `LOG_PROVIDER_RAW` and `LOG_PAYMENT_RAW` off in production. They write customer addresses to the logs.
- Use a dedicated receiving wallet and move funds out regularly.

## Going live checklist

- [ ] `JWT_SECRET` and `ADMIN_KEY` are long and random
- [ ] Provider and bulk credentials are real and were not shared anywhere
- [ ] `NODE_ENV=production`, site served over HTTPS
- [ ] `PAYMENT_PROVIDER=tron` with your real `TRON_ADDRESS`, checked character by character
- [ ] `src/fakePay.js` deleted (if you created it)
- [ ] `LOG_PROVIDER_RAW=0`, `LOG_PAYMENT_RAW` unset
- [ ] `.gitignore` covers `.env`, `data.db`, `data.db-*`, `backups/`, `node_modules/`
- [ ] One real $1 payment tested end to end
- [ ] One batch of 2,001+ addresses tested

## Troubleshooting

| Problem | Likely cause |
| --- | --- |
| `ERR_MODULE_NOT_FOUND` on start | A file is misnamed (for example `backup,js`) or in the wrong folder. Check the path in the error against the folder layout above. |
| "Set ... in your .env file" on start | A required variable is missing or invalid. The message names it. |
| Login seems to work, then logs out | `NODE_ENV=production` over plain `http://`. Use HTTPS. |
| `/manage-users` shows an error about a missing file | The `admin` folder must be in the project root, not inside `public/`. |
| Payment never detected | Check the transfer on tronscan.org: right token (USDT TRC-20), exact amount, sent before expiry. Set `LOG_PAYMENT_RAW=1`, restart and look at the console. |
| `trongrid_http_429` in console | Rate limited. Add a free `TRONGRID_API_KEY`. |
| Batch rejected as too small | Files need at least `BULK_MIN_PER_FILE` valid addresses (default 2,001). |
| "ACTION NEEDED" in console | The provider reported a balance or login problem. Top up or fix the account. Jobs keep their place and the worker retries after 60 seconds. |
| Outlook or Hotmail results vary between checks | Those domains often block or rate-limit verification probes. Unknown results are refunded and not cached. |