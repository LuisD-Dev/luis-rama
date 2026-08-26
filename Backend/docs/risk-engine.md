# Risk Engine — Tier A Practical Fraud Controls

## Overview
Deterministic, non-ML risk guard with two modes:

- **shadow (default)**: compute decision, log to `RiskDecision`, always allow.
- **enforce**: `allow | challenge (423) | block (403)`

Keeps engine pure (`services/riskEngine.js` → `evaluate(signals)`) and wiring boring.

## Signals (4)

| # | Signal | Window | Threshold (default) | Decision |
|---|--------|--------|---------------------|----------|
| 1 | Max payment attempts / user | rolling 1h | 8 | `challenge` |
| 2 | Max distinct `paymentMethodId` / user | rolling 24h | 4 | `block` |
| 3 | Max failed payments / IP hash | rolling 1h | 12 | `block` |
| 4 | Account age < X min + `master` tier | — | 30m | `challenge` |

`block` overrides `challenge`. Whitelisted users (`User.riskWhitelisted = true`) always `allow`.

## Data model

```prisma
model RiskDecision {
  id          Int      @id @default(autoincrement())
  userId      Int?     // nullable for anonymous/IP-only events
  ipHash      String   // sha256(IP + RISK_IP_HASH_SALT), 32 hex
  path        String   // e.g. /api/payments/payment-method
  signalsJson String   // snapshot of signals + thresholds
  score       Int      // 0..100, block=80, challenge=25
  decision    String   // allow | challenge | block
  mode        String   // shadow | enforce
  createdAt   DateTime
}
```

Every payment attempt persists a row, including **idempotent replays** (existing `idempotencyKey` returns stored payment but still logs a decision — Stripe is not double-charged).

## Config

Env (or JSON overrides passed to `evaluate`):

```
RISK_ENGINE_MODE=shadow|enforce          # default shadow
RISK_THRESHOLD_ATTEMPTS_USER_HOUR=8
RISK_THRESHOLD_DISTINCT_PM_DAY=4
RISK_THRESHOLD_FAILS_IP_HOUR=12
RISK_ACCOUNT_AGE_MINUTES=30
RISK_IP_HASH_SALT=<secret>               # optional, for IP hash
```

`getMode()` and `getThresholds()` read env with defaults documented in `riskEngine.DEFAULT_THRESHOLDS`.

## Wiring

- `routes/payments.js` calls `collectSignals()` → `evaluate()` → `persistDecision()` **before** `createOrReusePayment` / Stripe PI creation.
- `controllers/paymentsController.js` (`/intent`) also stores `ipHash` on `Payment`.
- If `mode=enforce` and decision != `allow`, route returns immediately:
  - `block` → `403 { code: RISK_BLOCK }`
  - `challenge` → `423 { code: RISK_CHALLENGE, message: Re-auth required }`
- In `shadow`, the same decision is logged but the request proceeds.

## Admin APIs

Requires `admin` role (`verifyToken` + `adminOnly`):

- `GET /api/payments/risk/decisions?limit=50&decision=block|challenge|allow` — recent decisions, newest first. Default shows `block`+`challenge`.
- `POST /api/payments/risk/whitelist/:userId { whitelisted: true|false }`
- `PATCH /api/payments/risk/whitelist/:userId` — same
- Also aliased `GET /api/payments/admin/decisions`

## Frontend

- `src/components/payments/StripeCardForm.jsx` maps `423/403` with `code RISK_CHALLENGE|RISK_BLOCK` to i18n strings (`src/i18n/messages.js`) and triggers re-auth (`invokeLogout → /auth/login`) for challenges, or cool-down message for blocks.
- `src/components/payments/CheckoutFlow.jsx` shows the same messages on `createPaymentIntent` failure.

## Runbook — How to whitelist a user

1. **Via admin endpoint** (recommended, audited):
   ```bash
   curl -X POST https://your.api/api/payments/risk/whitelist/123 \
     -H "Authorization: Bearer <ADMIN_JWT>" \
     -H "Content-Type: application/json" \
     -d '{"whitelisted": true}'
   ```
   Verify:
   ```bash
   curl https://your.api/api/payments/risk/decisions?limit=5 \
     -H "Authorization: Bearer <ADMIN_JWT>"
   ```

2. **Via DB flag** (emergency, direct):
   ```sql
   -- SQLite
   UPDATE users SET risk_whitelisted = 1 WHERE id = 123;
   -- Postgres
   UPDATE users SET risk_whitelisted = true WHERE id = 123;
   ```
   The whitelisted user will then get `decision: allow, reasons: ["whitelisted"]` for all future attempts, still audited.

To remove: set `whitelisted: false` or `risk_whitelisted = 0/false`.

## Testing

- `Backend/tests/riskEngine.test.js` (jest) — pure + integration: shadow allows, enforce blocks burst, 4 PMs, new-master, idempotent replay, admin read, whitelist, happy path.
- `Backend/tests/riskEngine.test.js` (node:test) for the simple `Backend/` server.
- Run: `npm test -- tests/riskEngine.test.js` (Teclia) or `npm test` (simple).

## Idempotency

Client sends `Idempotency-Key` header or `idempotencyKey` body field. Server checks `Payment.findUnique({ idempotencyKey })` first. On replay it returns `{ replay: true, ... }` without calling Stripe, but still persists a `RiskDecision`.

## Security notes

- Store only `ipHash`, never raw IP, in `RiskDecision`/`Payment.ipHash`.
- Stripe PM ids are opaque; never log full card data.
- No BIN/geo vendor required; stub `riskEngine.hashIp` can be extended.
- Challenge is “re-auth required”, not CAPTCHA.

