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

- Edit `Backend/.env` and set values for `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `JWT_SECRET`, `SENDGRID_API_KEY` (for emails), and `DATABASE_URL` (if using Postgres). See `.env.example` for descriptions for each variable.

Notes:
- If you do not set `DATABASE_URL`, the backend will use a local SQLite file (default) created under `Backend/`.
- The backend will fall back to a development `JWT_SECRET` if none is provided, but you should set `JWT_SECRET` for real development or production.

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
- If you want the backend DB to target Supabase Postgres, set `DATABASE_URL` to the Supabase Postgres connection string.

## 9) Database initialization, migrations and seed data

- The backend will automatically initialize the schema on startup when using SQLite or Postgres (see `Backend/db/init.js`).
- A default admin account is created automatically during initialization. Defaults are documented in `Backend/db/init.js`.
- If you need to run SQL scripts manually, examples are in `Backend/postgres_setup.sql` and `Backend/sqlite_setup.sql`.
- There is a `npm run migrate:postgres` script in `Backend/package.json` intended for migration helpers; inspect the script before running.

## 10) Common setup errors and fixes

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

## 12) Further reading

- API reference: [API_DOCUMENTATION.md](API_DOCUMENTATION.md)
- Code structure: inspect `Backend/routes`, `Backend/controllers`, and `Backend/db` for server behavior.

If you get stuck, open an issue with the output of your backend logs and the `.env` values you used (omit secrets).
