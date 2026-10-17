# Mailcheck

A small web app for email verification, sold by credits. Customers log in, buy credits with crypto (USDT on TRON), and check single addresses or upload files for batch checking.

Everything that talks to the verification providers runs on the server. The browser only ever talks to this app's own `/api/...` routes, so provider URLs, accounts and keys are never sent to a visitor.

## Features

- **Single check**: verify one address for 1 credit. Refunded automatically if the provider can't give an answer.
- **Batch check**: upload a CSV or text file. Credits are reserved up front, and anything not verified (errors, unknown results, wrong-format rows) is refunded when the job ends.
- **Credits ledger**: every credit added or spent is a row in `credit_ledger`. A balance is the sum of the rows.
- **Result cache**: definitive results are reused for `CACHE_DAYS` days, so repeat checks cost nothing extra.
- **Crypto payments**: USDT (TRC-20) with a unique amount per order, confirmed automatically by watching your wallet.
- **Owner tools**: create accounts, add credits and approve payments by hand from inside the site, behind a login and a second key.
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

There is no public signup. Create your first admin account from the command line (see "Accounts and owner tools").

## Configuration (`.env`)

Never commit `.env`. It is listed in `.gitignore`.

### Core

| Variable | Description |
| --- | --- |
| `PORT` | Port to listen on. Default `3000`. |
| `JWT_SECRET` | Random string, at least 32 characters. The app refuses to start without it. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Changing it logs everyone out. |
| `ADMIN_KEY` | Random string, at least 24 characters. Required for every owner tool. If it is unset or shorter, the tools stay locked even with the right login. Generate one the same way as `JWT_SECRET`, with `randomBytes(24)`. |
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
  private/
    panel.js              owner tools script (sent only to admin accounts)
  public/
    index.html            the customer-facing site
  src/
    server.js             routes, login, owner-tool routes, startup checks
    worker.js             batch job processing and refunds
    jobRoutes.js          upload, list, cancel, download
    billing.js            orders, fulfilment, manual approval
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

`private/` sits next to `public/`, not inside it. Everything in `public/` is served to anyone; `private/panel.js` is only handed out by a route that checks the logged-in user.

## Accounts and owner tools

### Creating the first admin

Run from the project folder. Wrap the password in quotes.

```
node --env-file=.env src/createUser.js myadmin "AnotherPass456" --admin
```

To make an existing user an admin, or to remove admin rights, run this in DB Browser and press Write Changes:

```sql
UPDATE users SET is_admin = 1 WHERE email = 'theirusername';
UPDATE users SET is_admin = 0 WHERE email = 'theirusername';
```

Usernames are stored lowercase in the `users.email` column (the column name is historical). Keep the number of admin accounts to one or two.

### Using the owner tools

1. Log in as an admin and open the **Profile** tab.
2. A **Tools** box appears, asking for the key. Enter your `ADMIN_KEY` and click **Unlock**.
3. Once unlocked you can:
   - **Create customer account**: username and password. These accounts are always normal users, never admins.
   - **Customer credits**: add or remove credits for a username (negative numbers remove).
   - **Unpaid crypto orders**: approve a payment by hand (see below).
4. Click **Lock**, refresh or log out to clear the key from the page.

Normal users never receive any of this. The owner-tool script is only sent to admin accounts, and a visitor who isn't an admin gets a 404 for it.

### How the protection works

- Every owner-tool route (`/api/ops/...`) requires **both** a logged-in admin session **and** the `ADMIN_KEY` in a request header.
- The key is checked in constant time and kept in the page's memory only. It is never stored in the browser.
- Wrong keys are limited to 10 per 15 minutes per IP address. Correct requests don't count.
- Don't let the browser save the key as a password.

Accounts can also be created from the command line without the site:

```
node --env-file=.env src/createUser.js john "StrongPass123"
```

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
2. In the Tools box, find the order in **Unpaid crypto orders** (match by username and amount).
3. Paste the transaction hash if you have it. This stops the same transaction from ever paying a second order, and the app refuses a hash that was already used.
4. If they paid a different amount than ordered, enter the number of credits to give. Otherwise leave it empty.
5. Click **Approve** and confirm.

Approving adds the credits, marks the order paid and saves the hash in one step, so the watcher can't credit it again. Expired orders can be approved too. An order can't be approved twice.

If the customer paid but never created an order, there is nothing to approve. Use **Customer credits** instead.

Don't use **Customer credits** for a payment that matches an open order. If the order is still pending, the watcher could credit it a second time when the real payment is detected. Approve the order instead.

## Working with the database

The database is a single SQLite file (`data.db`, plus `-shm` and `-wal` files while running). Open it with DB Browser for SQLite or the SQLite Viewer extension for VS Code.

- Copy `data.db` before editing anything, and press Write Changes when you finish so the lock is released.
- Don't edit or delete old `credit_ledger` rows. To change a balance, add a new row (use the Tools box).
- Don't edit `password_hash` by hand. It stores a bcrypt hash.
- Don't delete user rows. Their credits, orders and checks point to them.
- To restore a backup: stop the app, replace `data.db` with the backup, delete the leftover `data.db-shm` and `data.db-wal` files, and start again.

## Security notes

- Never commit `.env`, `data.db`, or `backups/`. If a secret was ever committed or pasted somewhere public, rotate it.
- Use HTTPS in production. Without it the secure session cookie won't be kept, and the login and key travel unencrypted.
- Give admin accounts long, unique passwords, and use them only for owner tasks. Test as a customer with a separate normal account.
- Never send provider error messages to the browser. Provider errors are only logged on the server; keep it that way.
- Keep `.env`, backups and anything private outside `public/`.
- Set `app.set('trust proxy', 1)` in `server.js` only if a reverse proxy or tunnel (nginx, Cloudflare, ngrok and similar) sits in front of the app. Otherwise leave it out.
- Turn `LOG_PROVIDER_RAW` and `LOG_PAYMENT_RAW` off in production. They write customer addresses to the logs.
- Use a dedicated receiving wallet and move funds out regularly.
- Keep the repository private. This README describes how the app is protected.

## Going live checklist

- [ ] `JWT_SECRET` and `ADMIN_KEY` are long and random
- [ ] Provider and bulk credentials are real and were not shared anywhere
- [ ] `NODE_ENV=production`, site served over HTTPS
- [ ] `PAYMENT_PROVIDER=tron` with your real `TRON_ADDRESS`, checked character by character
- [ ] `src/fakePay.js` deleted (if you created it)
- [ ] `LOG_PROVIDER_RAW=0`, `LOG_PAYMENT_RAW` unset
- [ ] `.gitignore` covers `.env`, `data.db`, `data.db-*`, `backups/`, `node_modules/`
- [ ] Only the admin accounts you need exist, each with a strong password
- [ ] Logged in as a normal user, page source (Ctrl+U) contains nothing about the owner tools
- [ ] One real $1 payment tested end to end
- [ ] One batch of 2,001+ addresses tested

## Troubleshooting

| Problem | Likely cause |
| --- | --- |
| `ERR_MODULE_NOT_FOUND` on start | A file is misnamed (for example `backup,js`) or in the wrong folder. Check the path in the error against the folder layout above. |
| "Set ... in your .env file" on start | A required variable is missing or invalid. The message names it. |
| Login seems to work, then logs out | `NODE_ENV=production` over plain `http://`. Use HTTPS. |
| No Tools box in Profile | The account isn't an admin (`SELECT id, email, is_admin FROM users;`), or `private/panel.js` is missing or in the wrong folder. Log out and in after changing `is_admin`. |
| "Wrong key." | The key doesn't match `ADMIN_KEY`, or `ADMIN_KEY` is shorter than 24 characters, or you didn't restart after changing `.env`. After 10 wrong tries wait 15 minutes. |
| Payment never detected | Check the transfer on tronscan.org: right token (USDT TRC-20), exact amount, sent before expiry. Set `LOG_PAYMENT_RAW=1`, restart and look at the console. If it's genuine, approve it by hand. |
| `trongrid_http_429` in console | Rate limited. Add a free `TRONGRID_API_KEY`. |
| Batch rejected as too small | Files need at least `BULK_MIN_PER_FILE` valid addresses (default 2,001). |
| "ACTION NEEDED" in console | The provider reported a balance or login problem. Top up or fix the account. Jobs keep their place and the worker retries after 60 seconds. |
| Outlook or Hotmail results vary between checks | Those domains often block or rate-limit verification probes. Unknown results are refunded and not cached. |