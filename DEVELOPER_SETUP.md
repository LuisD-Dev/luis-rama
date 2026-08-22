# Developer Setup — Teclia Academia

This guide walks a new developer through cloning the repository, installing dependencies, configuring environment variables, and running both frontend and backend locally.

## 1) Project overview

- Frontend: React + Vite app located at the repository root.
- Backend: Express server and lightweight database code in `Backend/`.
- Database: Defaults to local SQLite (no external services required). Optionally use PostgreSQL or Supabase for production.

## 2) Tech stack

- Frontend: React 18, Vite, Axios
- Backend: Node.js (ESM), Express, JWT authentication, multer for file uploads
- Storage: Optional Supabase storage (client in `Backend/lib/supabaseClient.js`)
- Database: SQLite (local file) or PostgreSQL via `DATABASE_URL`

## 3) Prerequisites

- Node.js 18.x or later (LTS recommended). Verify with `node -v`.
- npm (bundled with Node) or an alternative package manager (Yarn, pnpm) — npm examples are used here.
- Optional: `psql` if you plan to run Postgres SQL scripts locally.

## 4) Clone the repository

```bash
git clone https://github.com/<your-org>/Teclia-Academy.git
cd Teclia-Academy
```

## 5) Install dependencies

- Frontend (root):

```bash
npm install
```

- Backend (Backend/):

```bash
cd Backend
npm install
```

## 6) Configure environment variables

- Copy the example file to create a real `.env` for the backend:

```bash
cd Backend
cp ../.env.example .env
# On Windows PowerShell: copy ../.env.example .env
```

- Edit `Backend/.env` and set values for `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `JWT_SECRET`, `SENDGRID_API_KEY` (for emails), and `DATABASE_URL` (if using Postgres). When `LOCAL_UPLOADS=true`, also set a separate, long random `MEDIA_SIGNING_SECRET`. See `.env.example` for descriptions for each variable.

Notes:
- If you do not set `DATABASE_URL`, the backend will use a local SQLite file (default) created under `Backend/`.
- The backend will fall back to a development `JWT_SECRET` if none is provided, but you should set `JWT_SECRET` for real development or production.
- `CONTENT_SIGNED_URL_TTL_SECONDS` controls paid-content URL lifetime and defaults to 900 seconds. The backend constrains it to 300-900 seconds.
- Do not reuse `JWT_SECRET` as `MEDIA_SIGNING_SECRET`; rotating one secret should not invalidate both authentication and media URLs.
- Local storage keys may contain decoded spaces and Unicode characters, but must not contain a literal `%` followed by two hexadecimal characters. Local uploads already normalize filenames to UUID-based keys; custom/imported keys must apply the same policy so residual URL encoding cannot be mistaken for a real filename.

## 7) Running the project locally

- Start backend (from `Backend/`):

```bash
cd Backend
npm run dev
```

The backend listens on `PORT` (defaults to `3001`). APIs mount under `/api` (for example `http://localhost:3001/api/auth/login`).

- Start frontend (from repository root):

```bash
npm run dev
```

The Vite dev server typically runs on `http://localhost:5173`.

## Stripe Elements and test payments

The card form uses Stripe Elements. Card data is entered inside Stripe's hosted iframe and does not pass through React state or the Teclia API. The frontend sends the backend only a Stripe Payment Method identifier.

### Get a test publishable key

1. Create or open a Stripe account at [dashboard.stripe.com](https://dashboard.stripe.com/).
2. Enable test mode in the Stripe Dashboard.
3. Open **Developers > API keys** and copy the **Publishable key** that starts with `pk_test_`.
4. Never put a secret key (`sk_test_` or `sk_live_`) in a `VITE_` variable. Vite variables are included in browser code.

### Configure the frontend locally

Create `.env` at the repository root (next to `package.json`) and add:

```dotenv
VITE_STRIPE_PUBLISHABLE_KEY=pk_test_your_key_here
VITE_PAYMENTS_ENABLED=true
```

Restart `npm run dev` after changing either variable because Vite reads them when the app starts.

`VITE_PAYMENTS_ENABLED=true` activates the Stripe form and allows the frontend to tokenize test cards with Stripe. It does not enable an end-to-end local checkout because the required backend route is not implemented yet. Set it to `false`, remove it, or omit `VITE_STRIPE_PUBLISHABLE_KEY` to show the safe **Pagos no disponibles** fallback. `VITE_PAYMENTS_ENABLED` is the Vite-exposed frontend equivalent of the `PAYMENTS_ENABLED` feature flag.

### Backend contract

After Stripe tokenizes the card successfully, the frontend attempts to call `POST /api/payments/payment-method` with this exact JSON body:

```json
{
  "paymentMethodId": "pm_..."
}
```

> ⚠️ **Nota:** el endpoint `POST /api/payments/payment-method` aún no está implementado en el backend de este repositorio. Hasta que se agregue, la tokenización con Stripe funcionará pero el envío del `paymentMethodId` al backend devolverá `404`.

The request must never contain a card number, CVC, or expiration date. A future backend implementation must receive only this ID and perform any Payment Intent or subscription work server-side. Until that route exists, the complete checkout flow is unavailable in local development.

### Stripe test cards

Use these only while Stripe is in test mode. Use any future expiration date and any three-digit CVC unless the scenario says otherwise.

| Scenario | Card number | Expected result |
| --- | --- | --- |
| Successful Visa | `4242 4242 4242 4242` | Tokenization succeeds |
| Generic decline | `4000 0000 0000 0002` | Card declined |
| Insufficient funds | `4000 0000 0000 9995` | Insufficient funds decline |
| Expired card | `4000 0000 0000 0069` | Expired card error |
| Incorrect CVC | `4000 0000 0000 0127` | Incorrect security code error |
| Processing error | `4000 0000 0000 0119` | Temporary processing error |

Do not use real card details in test mode. See Stripe's current [testing documentation](https://docs.stripe.com/testing) for more scenarios.

## 8) Connecting to Supabase (optional)

If you prefer to use Supabase for storage and/or Postgres hosting:

- Create a Supabase project and a storage bucket (default bucket name in this project: `uploads`).
- Copy `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` into your `Backend/.env`.
- Ensure `SUPABASE_SERVICE_KEY` is the service-role key (required for server-side uploads/deletes).
- Configure paid-content objects in a **private** bucket. `createSignedUrl` limits access only when the underlying object is not also publicly readable. The service-role key stays on the backend and is used to create short-lived URLs after the plan check succeeds.
- If free objects must remain permanently public, store them under a separately public storage policy/bucket; never make the bucket containing paid objects public.

> **Security warning:** a signed URL does not protect an object that is also publicly readable. Never configure the bucket or storage policy containing paid content for public access.
- If you want the backend DB to target Supabase Postgres, set `DATABASE_URL` to the Supabase Postgres connection string.

## 9) Database initialization, migrations and seed data

- The backend will automatically initialize the schema on startup when using SQLite or Postgres (see `Backend/db/init.js`).
- A default admin account is created automatically during initialization. Defaults are documented in `Backend/db/init.js`.
- If you need to run SQL scripts manually, examples are in `Backend/postgres_setup.sql` and `Backend/sqlite_setup.sql`.
- There is a `npm run migrate:postgres` script in `Backend/package.json` intended for migration helpers; inspect the script before running.

## 10) Common setup errors and fixes

- "MEDIA_SIGNING_SECRET must be defined" — Set a long random server-side secret when `LOCAL_UPLOADS=true`. Rotating it invalidates previously issued local media URLs.

- "SUPABASE_URL and SUPABASE_SERVICE_KEY must be defined" — Copy `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` into `Backend/.env` or remove Supabase-dependent calls if you are working purely with local uploads.
- "No token provided" or 401 responses — Ensure `JWT_SECRET` is set in `Backend/.env` and that you include `Authorization: Bearer <token>` in requests that require authentication.
- Port already in use — Change `PORT` in `Backend/.env` or stop the process using the port.
- File upload errors with multer — Ensure the `uploads/` directory is writable or that Supabase credentials are correct for server-side uploads.
- Email (SendGrid) failures — Set `SENDGRID_API_KEY` or disable email-based flows (password reset) during local development.

## 11) Helpful commands

- Backend in production mode:

```bash
cd Backend
npm start
```

- Purge non-admin users (utility):

```bash
node ./scripts/purge_non_admins.js
```

## 11.1) Payment Reconciliation Runbook

Stripe webhooks are the primary way `Payment` rows move from `pending` to `completed`. Webhooks can be lost — a deploy restarts the server mid-delivery, the handler 500s, `STRIPE_WEBHOOK_SECRET` gets rotated without updating the Dashboard, or Stripe simply can't reach the endpoint for a while. When that happens, Stripe's own record of a `PaymentIntent` is the source of truth and the local `Payment` row silently drifts out of sync. `npm run payments:reconcile` (`Backend/scripts/reconcilePayments.js`, backed by `Backend/services/paymentReconcileService.js`) detects and repairs that drift.

It complements, not replaces, the webhook handlers in [routes/webhooks.js](Backend/routes/webhooks.js) and [controllers/paymentsController.js](Backend/controllers/paymentsController.js) — run it after an incident, not instead of fixing webhook delivery.

### When to run it

- After any incident where webhook delivery may have been interrupted (deploy, 500s in the logs for `/api/payments/webhook` or `/api/webhooks/stripe`, a rotated `STRIPE_WEBHOOK_SECRET`).
- On a schedule as a safety net (see "Scheduling" below) — this tool has no built-in scheduler.
- Ad hoc, when a user reports "I paid but I don't have access" — use `--payment-id`.

### Flags

| Flag | Description |
| --- | --- |
| `--since` | Time window to scan, e.g. `24h`, `7d`, `30m`. Required unless `--payment-id` is given. |
| `--limit` | Maximum number of candidates to process (default 50). |
| `--payment-id` | Reconcile a single `Payment` row by id, ignoring `--since`/`--limit`. |
| `--dry-run` | Explicit no-op flag — dry-run is already the default. Never writes to the database. |
| `--apply` | Actually repair the mismatches found. Without it, the command always behaves as `--dry-run`. |

### Dry-run (safe, default)

```bash
cd Backend
npm run payments:reconcile -- --since=24h --dry-run
```

Prints a table of every payment checked (local status vs. Stripe status) and a JSON summary. Makes zero writes — no `Payment` updates, no `PaymentEvent` rows.

### Apply (repairs divergences)

```bash
cd Backend
npm run payments:reconcile -- --since=7d --apply --limit=100
npm run payments:reconcile -- --payment-id=123 --apply
```

Requires `STRIPE_SECRET_KEY`. If `NODE_ENV=production`, it additionally refuses to run unless `RECONCILE_CONFIRM=YES` is set for that invocation:

```bash
RECONCILE_CONFIRM=YES npm run payments:reconcile -- --since=24h --apply --limit=200
```

Only four Stripe `PaymentIntent` statuses are ever acted on (`succeeded`, `canceled`, `requires_payment_method`, `requires_action` — see the mapping table in `paymentReconcileService.js`). Anything else is left untouched: the tool never guesses at an in-flight payment. Entitlements only move on the two conclusive ends of that mapping:

- `succeeded` — grants/ensures `planTier` and premium access (via `markPaymentCompleted`, the same function the webhook handler uses).
- `canceled` — if the local `Payment` had already reached `completed` (i.e. it had actually granted access), reconciliation **revokes** that access: the `Subscription` tied to that PaymentIntent is marked `canceled` and the user is downgraded to `planTier: null` / `role: 'student'`. If the payment was still `pending`/`failed` (nothing was ever granted), this is just a status correction — no entitlement change.

`requires_payment_method`/`requires_action` only normalize `Payment.status` to `pending`; they never touch entitlements either way. Every repair is written through the same `markPaymentCompleted`/`recordPaymentEvent` functions the webhook handlers use, and every candidate examined in `--apply` mode writes a `PaymentEvent` (`reconcile.checked`, `reconcile.mismatch`, `reconcile.repaired`, `reconcile.skipped`, or `reconcile.error`) so the run is fully auditable after the fact.

### Reading the summary

```json
{
  "checked": 125,
  "mismatched": 8,
  "repaired": 6,
  "skipped": 2,
  "errors": 0
}
```

- `checked` — total candidates examined.
- `mismatched` — local status disagreed with Stripe's.
- `repaired` — mismatches fixed (only in `--apply` mode; always `0` in dry-run).
- `skipped` — a Stripe `PaymentIntent` was found with no matching local `Payment` row (nothing to repair — investigate manually).
- `errors` — a candidate failed to process (Stripe API error, DB error, etc.). The run continues past individual errors, but the process exits non-zero (`errors > 0`) so this is safe to wire into CI/alerting.

### Incident checklist ("webhooks stopped arriving at 2am")

1. Confirm the incident window (deploy time, first failed webhook log line, secret rotation time).
2. Run a dry-run over that window: `npm run payments:reconcile -- --since=24h --dry-run`. Read the table before touching anything.
3. If the diffs look correct, re-run with `--apply` (add `RECONCILE_CONFIRM=YES` in production) and a `--limit` you're comfortable reviewing (start with `--limit=20` for a first pass on an unfamiliar incident).
4. Re-run the same `--since` window with `--dry-run` afterward — `mismatched` should now be `0` (or explain the remainder).
5. Fix the root cause of the webhook gap (redeploy the handler, update `STRIPE_WEBHOOK_SECRET` in the Stripe Dashboard, etc.) before closing the incident — this tool repairs data, it does not fix delivery.

### Scheduling

There is no cron runner bundled with this repo. To run this on a schedule, invoke `npm run payments:reconcile -- --since=1h --apply --limit=200` (with `RECONCILE_CONFIRM=YES` in production) from whatever scheduler already exists in your deployment — e.g. a platform cron job, GitHub Actions scheduled workflow, or a process manager timer — and alert on a non-zero exit code.

## 12) Further reading

- API reference: [API_DOCUMENTATION.md](API_DOCUMENTATION.md)
- Code structure: inspect `Backend/routes`, `Backend/controllers`, and `Backend/db` for server behavior.

If you get stuck, open an issue with the output of your backend logs and the `.env` values you used (omit secrets).
