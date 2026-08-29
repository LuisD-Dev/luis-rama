# API Documentation — Teclia Academia

Base URL (local): `http://localhost:3001/api`

Base URL (production): `https://<your-production-host>/api` (replace with your real host)

Authentication

- The backend uses JWT tokens. After login you receive a token in the response. Send it in requests using the `Authorization` header:

  Authorization: Bearer <token>

- Backend enforces role checks with `admin` and non-admin (`student`/`premium`) roles.

Routes are grouped below. All examples assume the base URL prefix `/api`.

----

**Common fields**

- `entitlement_epoch` / `entitlementEpoch`: Monotonic integer that increments on every plan change. Clients should compare this value across responses; if it changes, cached content is stale and must be refetched.

  Note: for historical reasons, this field is serialized as `entitlement_epoch`
  (snake_case) in user payloads and as `entitlementEpoch` (camelCase) in
  content response metadata. Clients must handle both forms.

----

**Auth routes** (`/api/auth`)

- POST /api/auth/signup
  - Description: Register a new user (student by default).
  - Auth required: No
  - Body example:

```json
{
  "email": "student@example.com",
  "password": "StrongPass123!",
  "name": "Student Name"
}
```

  - Response example (201/200):

```json
{
  "message": "User created successfully",
  "token": "<jwt>",
  "user": { "id": 5, "email": "student@example.com", "name": "Student Name", "role": "student", "plan_tier": null, "entitlement_epoch": 0, "avatar_url": null }
}
```

- POST /api/auth/login
  - Description: Authenticate user and obtain JWT.
  - Auth required: No
  - Body example:

```json
{
  "email": "student@example.com",
  "password": "StrongPass123!"
}
```

  - Response example (200):

```json
{
  "message": "Login successful",
  "token": "<jwt>",
  "user": { "id": 5, "email": "student@example.com", "name": "Student Name", "role": "student", "plan_tier": null, "entitlement_epoch": 0, "avatar_url": null }
}
```

- GET /api/auth/me
  - Description: Retrieve current user's profile.
  - Auth required: Yes (Bearer token)
  - Response example (200):

```json
{
  "user": { "id": 5, "email": "student@example.com", "name": "Student Name", "role": "student", "plan_tier": null, "entitlement_epoch": 0, "avatar_url": null }
}
```

- PATCH /api/auth/profile
  - Description: Update profile fields; supports multipart `avatar` upload (file field name: `avatar`).
  - Auth required: Yes
  - Body (multipart/form-data): `name`, `avatar` (file) or `avatarUrl` (string)
  - Response example:

```json
{
  "message": "Profile updated successfully",
  "user": { "id": 5, "email": "...", "name": "New Name", "role": "student", "avatar_url": "https://..." }
}
```

- POST /api/auth/change-password
  - Description: Change current user's password
  - Auth required: Yes
  - Body example:

```json
{
  "currentPassword": "OldPass123",
  "newPassword": "NewPass456!"
}
```

- POST /api/auth/forgot-password
  - Description: Start password reset flow — sends a PIN by email
  - Auth required: No
  - Body example: `{ "email": "user@example.com" }`

- POST /api/auth/reset-password
  - Description: Complete reset using email + PIN
  - Auth required: No
  - Body example:

```json
{
  "email": "user@example.com",
  "pin": "123456",
  "newPassword": "NewStrongPass!"
}
```

- POST /api/auth/verify-recovery-email
  - Description: Check if email is registered (helper for reset flows)
  - Auth required: No
  - Body example: `{ "email": "user@example.com" }`

- GET /api/auth/students
  - Description: List non-admin users
  - Auth required: Yes
  - Role: admin only
  - Response example:

```json
{ "students": [ { "id": 2, "email": "s1@...", "name": "S1" } ] }
```

- PATCH /api/auth/students/:id/plan
  - Description: Admin updates a student's `plan_tier` (examples: `basico`, `pro`, `master`). Send `null` or `""` to remove the plan (downgrade to free).
  - Auth required: Yes
  - Role: admin only
  - Body example: `{ "plan_tier": "pro" }`
  - Response example:

```json
{
  "message": "Plan pro assigned successfully",
  "student": { "id": 2, "email": "s1@...", "name": "S1", "plan_tier": "pro", "entitlement_epoch": 4 }
}
```

  - Note: `entitlement_epoch` increments even when the assigned `plan_tier` is
    identical to the student's current plan. This is intentional — it forces
    client cache invalidation as a security measure, not an optimization.

- DELETE /api/auth/students/:id
  - Description: Admin deletes a student account
  - Auth required: Yes
  - Role: admin only

----

**Content routes** (`/api/content`)

- GET /api/content
  - Description: Retrieve all content available to the requesting user. If no token provided, only `free` content is returned.
  - Auth required: Optional
  - Response example:

```json
{
  "content": [ { "id": 1, "title": "Lesson 1", "type": "video", "url": "https://...", "plan_tier": "free", "uploaded_by": 2 } ],
  "meta": { "entitlementEpoch": 3 }
}
```

- GET /api/content/free
  - Description: List free content only (requires authentication check in routes but returns public content)
  - Auth required: Yes (route verifies token in code)

- GET /api/content/:id
  - Description: Get a single content item by id (access is checked against user's plan)
  - Auth required: Optional
  - Responses:
    - 200: content object
    - 403: insufficient plan access
    - 404: not found

- POST /api/content/upload
  - Description: Upload content (admin-only). Supports file upload via `file` (multipart/form-data) or providing an external `url` string.
  - Auth required: Yes
  - Role: admin only
  - Body (multipart/form-data): `title` (required), `type` (required), `file` (optional), `url` (optional), `is_free` (optional), `plan_tier` (optional)
  - Response example:

```json
{ "message": "Content uploaded", "content": { "id": 10, "title": "..." } }
```

- DELETE /api/content/:id
  - Description: Delete content by id (admin-only)
  - Auth required: Yes
  - Role: admin only

----

**Stats routes** (`/api/stats`)

- POST /api/stats/visit
  - Description: Increment site visit counter. Typically used by frontend to record visits.
  - Auth required: No
  - Body example: none
  - Response example:

```json
{ "total": 123 }
```

- GET /api/stats/visits
  - Description: Admin-only endpoint that returns aggregate site stats such as page visits and student count.
  - Auth required: Yes
  - Role: admin only
  - Response example:

```json
{ "pageVisits": 123, "studentCount": 42 }
```

----

**Admin routes** (`/api/admin`)

- GET /api/admin/stats
  - Description: Admin-only dashboard metrics with payment-based revenue and active subscriptions by tier.
  - Auth required: Yes
  - Role: admin only
  - Revenue source during status rollout: `succeeded`, plus legacy `completed` and `processed` Payment rows until operator migration is complete.
  - Response example:

```json
{
  "pageVisits": 123,
  "studentCount": 42,
  "revenueThisMonth": 180.0,
  "revenueLastMonth": 40.0,
  "revenueChange": 350,
  "activeSubscriptions": {
    "basico": 10,
    "pro": 6,
    "master": 2,
    "total": 18
  },
  "currency": "USD"
}
```

**Payments routes** (`/api/payments`)

- POST /api/payments/checkout
  - Description: Create a Stripe Checkout Session for the authenticated user’s selected plan. A local `Payment` is committed as `pending` before the Stripe network request, then linked to the returned Checkout Session.
  - Auth required: Yes (Bearer token)
  - Body example:

```json
{
  "plan": "basico"
}
```

  - Accepted `plan` values: `basico`, `pro`, `master` (mapped to Stripe Price IDs via `STRIPE_PRICE_BASICO`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_MASTER`).
  - Response example (200):

```json
{
  "checkoutUrl": "https://checkout.stripe.com/c/pay/cs_test_...",
  "sessionId": "cs_test_..."
}
```

  - Error responses:
    - `401` — missing or invalid JWT
    - `400` — missing/invalid `plan`, or missing Stripe price / success/cancel URL configuration
    - `502` — Stripe API failure (safe client message; details logged server-side only)

  - An authoritative Stripe rejection may transition the local Payment from `pending` to `failed`.
  - An ambiguous network/transport failure does not automatically mark the Payment failed because Stripe may have created the remote object.
  - `checkout.session.completed` advances the Payment through canonical transitions to `succeeded`. Entitlement effects run only for the execution that wins the `processing` → `succeeded` transition; duplicate or already-succeeded deliveries do not repeat them.

- POST /api/payments/payment-method
  - Description: Existing Stripe Elements path. Confirms a PaymentIntent for a tokenized `paymentMethodId` (not hosted Checkout).
  - Auth required: Yes (Bearer token)
  - Body: `{ "paymentMethodId": "pm_...", "planTier": "basico", "idempotencyKey": "..." }` (idempotency key may also be sent as `Idempotency-Key` header)
  - Response example (200):

```json
{
  "paymentId": 123,
  "stripePaymentIntentId": "pi_...",
  "status": "pending",
  "planTier": "pro"
}
```

  - `stripePaymentIntentId` is the attached Stripe identifier, or `null` when no identifier has been attached.
  - Normal responses use `pending`, `processing`, `succeeded`, `failed`, or `canceled`. The internal `created` state should not escape the committed creation flow.
  - `pending` and `processing` mean the payment is not yet complete. Only `succeeded` is completed success. `canceled` is terminal; `failed` may return to `pending` only through explicit trusted admin/system reconciliation.
  - A synchronous Stripe response of `succeeded` may intentionally return local `processing`. The signed PaymentIntent webhook owns the atomic `processing` → `succeeded` transition and entitlement activation.
  - A client must evaluate the response status and must not treat HTTP 200 alone as completed payment.
  - The same idempotency key with the same user, plan, amount, currency, provider, and payment method may reuse the existing Payment. Reusing the key with any mismatched payment request returns `409` without exposing another user's Payment identifiers.

### Canonical Payment status model

Canonical `Payment.status` values are exactly:

`created`, `pending`, `processing`, `succeeded`, `failed`, `canceled`

| From | Allowed to |
|---|---|
| `created` | `pending` |
| `pending` | `processing`, `failed`, `canceled` |
| `processing` | `succeeded`, `failed`, `canceled` |
| `failed` | `pending` only through explicit trusted admin/system reconciliation |
| `succeeded` | terminal |
| `canceled` | terminal |

Same-state observations are idempotent no-ops. Illegal transitions return a controlled conflict. `succeeded` and `canceled` cannot be resurrected, and `failed` cannot jump directly to `succeeded`. The `failed` → `pending` edge requires trusted reconciliation metadata and is not available to normal user/API retries.

`completed` and `processed` are legacy persisted success values only; they are not canonical statuses. The runtime temporarily recognizes them in read-only compatibility checks until the outstanding data migration is rolled out. This documentation does not imply that existing rows have already been migrated.

### Legacy status migration and operator fallback

The Prisma schema source now defaults new `Payment.status` values to `created`. This source change does not alter the default of an already-existing database by itself.

The standard migration path includes the data-only migration `Backend/prisma/migrations/20260821010000_canonical_payment_statuses/migration.sql`, which idempotently converts persisted `completed` and `processed` values to `succeeded`. Its presence does not imply that it has already run against production data.

The shared Prisma migration history still contains a pre-existing duplicate Payment-table migration at `20260725120000_add_payments`. This change does not edit historical migration checksums, run `prisma migrate resolve`, or repair that broader migration chain. Because the chain may prevent standard migration execution in some environments, the explicit operator utility remains available as a safe fallback:

```bash
npm run payment-status:migrate:dry-run
npm run payment-status:migrate
```

Run the fallback dry run first against the target database. The apply command converts only `completed` and `processed` to `succeeded`; unknown noncanonical values remain unchanged and cause a nonzero exit. The Prisma data migration and operator utility have distinct standard/fallback roles.

### Exactly-once success effects

Entitlement activation may occur only for the execution that actually wins the compare-and-set transition from `processing` to `succeeded`. Merely observing an already-succeeded Payment never reactivates entitlement. This rule covers duplicate webhook delivery, repeated admin confirmation, distinct success deliveries, and concurrent success processing.

### Stripe webhook delivery

- Canonical endpoint: `POST /api/webhooks/stripe`
- Compatibility alias: `POST /api/payments/webhook`
- Auth: no JWT; Stripe authenticates with the `stripe-signature` header over the exact raw request body.

Configure Stripe to deliver every supported payment and subscription event to the canonical endpoint only. The payments-path endpoint is a thin backward-compatibility alias that calls the same verifier and dispatcher; it is not a second Stripe destination. Both paths therefore have identical signature, response, dispatch, and idempotency behavior under the single `STRIPE_WEBHOOK_SECRET` configured for the canonical destination.

The verifier passes the original request `Buffer` directly to `stripe.webhooks.constructEvent`, without parsing, re-serialization, trimming, or text re-encoding. `STRIPE_WEBHOOK_TOLERANCE_SEC` controls the signed-timestamp tolerance and defaults to `300` seconds. No JSON/body parser may run before the route-specific raw-body middleware. On Vercel, `NODEJS_HELPERS=0` is required so the external `/api/webhooks/stripe` request retains its exact bytes through the `/api/(.*)` to `/api` rewrite.

| Condition | Response |
| --- | --- |
| Valid event processed or intentionally ignored | `200` |
| Duplicate event already committed under the same `PaymentEvent.stripeEventId` | `200` |
| Missing/invalid signature, timestamp outside tolerance, or invalid JSON | `400` |
| Verified event fails with a retryable dispatcher/database error | `500` |
| Webhook configuration is unavailable at request time outside the production startup check | `503` |

Production fails during application startup when `STRIPE_WEBHOOK_SECRET` is missing. A Vercel production deployment likewise fails startup unless `NODEJS_HELPERS` is exactly `0`. These fail-closed checks prevent the application from accepting unsigned webhooks or a request body that Vercel may already have parsed.

After verification, a valid delivery is claimed by the unique `PaymentEvent.stripeEventId` boundary. The claim, Payment resolution, state transitions, winner-gated entitlement activation, and final event outcome are committed atomically.

A PaymentIntent event resolves its local Payment in this order:

1. `stripePaymentIntentId`
2. Stripe `metadata.paymentId`

The metadata fallback supports a webhook arriving after the local Payment commits but before the Stripe PaymentIntent id is attached locally. If both identifiers resolve to different Payments, processing fails and no entitlement is applied. If neither resolves, processing fails so Stripe can retry. Other webhook domain failures also return a retryable server failure instead of acknowledging a lost payment.

A duplicate `stripeEventId` is an HTTP-successful no-op only after the original transaction has committed. If the original transaction rolls back, its event claim also rolls back and a later delivery can retry normally.

----

**Payment persistence schema**

All runtime `Payment.status` writes go through `Backend/services/paymentStateMachine.js`. Payment orchestration and non-status mutations remain in `Backend/services/paymentService.js`; controllers/routes must not write Payment status directly.

### `payments`

| Field | Type | Notes |
|---|---|---|
| `id` | Int PK | |
| `user_id` | Int FK → users | Indexed with `created_at` |
| `plan_tier` | String | `basico` \| `pro` \| `master` |
| `amount` | Int | Amount in cents |
| `currency` | String | Default `usd` |
| `status` | String | Source default `created`. Canonical: `created` \| `pending` \| `processing` \| `succeeded` \| `failed` \| `canceled`; legacy persisted success values may still be `completed` or `processed` pending operator migration |
| `provider` | String | Default `stripe` |
| `external_id` | String? | Provider payment/session id |
| `idempotency_key` | String UNIQUE | Prevents duplicate intents |
| `metadata` | String? | JSON blob |
| `stripe_payment_intent_id` | String? UNIQUE | Stripe PI (legacy/elements path) |
| `stripe_checkout_session_id` | String? UNIQUE | Stripe Checkout session |
| `created_at` / `updated_at` | DateTime | |

Indexes: unique `idempotency_key`; index `(user_id, created_at)`.

### `subscriptions`

| Field | Type | Notes |
|---|---|---|
| `id` | Int PK | |
| `user_id` | Int FK → users | |
| `plan_tier` | String | |
| `status` | String | `active` \| `canceled` \| `past_due` |
| `provider` | String | Default `stripe` |
| `external_id` | String | Unique with `provider` |
| `current_period_start` / `current_period_end` | DateTime | |

Created/activated in the same transaction as successful Payment processing, and only when that execution wins the canonical `processing` → `succeeded` transition. Observing an already-succeeded Payment does not repeat entitlement activation.

### `payment_events`

| Field | Type | Notes |
|---|---|---|
| `id` | Int PK | |
| `payment_id` | Int? FK → payments | |
| `type` | String | e.g. `payment.completed`, Stripe event types |
| `payload` | String | JSON |
| `processed_at` | DateTime? | |
| `idempotency_key` | String UNIQUE | Dedupes event processing |
| `stripe_event_id` | String? UNIQUE | Stripe delivery idempotency boundary |
| `outcome` | String? | Processing result, for example `processing`, `processed`, `ignored`, or an idempotent/terminal observation |

Payment audit migration: `Backend/prisma/migrations/20260720230001_payment_audit_trail/migration.sql`. Canonical status data migration: `Backend/prisma/migrations/20260821010000_canonical_payment_statuses/migration.sql`.
----

Notes and mapping

- The API endpoints in this documentation correspond to the server code under `Backend/routes`.
- If you expect endpoints named differently (for example `/stats` vs `/stats/visits`), use the endpoints as implemented: e.g., visit counter is `POST /api/stats/visit` and admin stats are `GET /api/stats/visits`.

Error responses

- The API returns standard HTTP status codes. Error payloads typically include an `error` message string, e.g. `{ "error": "Invalid credentials" }`.

Auth header example (curl):

```bash
curl -H "Authorization: Bearer <token>" http://localhost:3001/api/auth/me
```

If you plan to extend any endpoint, update this document accordingly and include request/response examples.
