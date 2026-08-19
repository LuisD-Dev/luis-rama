# API Documentation — Teclia Academia

Base URL (local): `http://localhost:3001/api`

Base URL (production): `https://<your-production-host>/api` (replace with your real host)

Authentication

- The backend uses JWT tokens. After login you receive a token in the response. Send it in requests using the `Authorization` header:

  Authorization: Bearer <token>

- Backend enforces role checks with `admin` and non-admin (`student`/`premium`) roles.

Routes are grouped below. All examples assume the base URL prefix `/api`.

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
  "user": { "id": 5, "email": "student@example.com", "name": "Student Name", "role": "student", "avatar_url": null }
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
  "user": { "id": 5, "email": "student@example.com", "name": "Student Name", "role": "student", "plan_tier": null, "avatar_url": null }
}
```

- GET /api/auth/me
  - Description: Retrieve current user's profile.
  - Auth required: Yes (Bearer token)
  - Response example (200):

```json
{
  "user": { "id": 5, "email": "student@example.com", "name": "Student Name", "role": "student", "plan_tier": null, "avatar_url": null }
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
  - Description: Admin updates a student's `plan_tier` (examples: `basico`, `pro`, `master`)
  - Auth required: Yes
  - Role: admin only
  - Body example: `{ "plan_tier": "pro" }`

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
{ "content": [ { "id": 1, "title": "Lesson 1", "type": "video", "url": "https://...", "plan_tier": "free", "uploaded_by": 2 } ] }
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
  - Revenue source: only `completed` payment records from `payments` table.
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
  - `pending` and `processing` mean the payment is not yet complete. Only `succeeded` is completed success; `failed` and `canceled` are terminal failure states.
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

### Exactly-once success effects

Entitlement activation may occur only for the execution that actually wins the compare-and-set transition from `processing` to `succeeded`. Merely observing an already-succeeded Payment never reactivates entitlement. This rule covers duplicate webhook delivery, repeated admin confirmation, distinct success deliveries, and concurrent success processing.

### PaymentIntent webhook delivery

`POST /api/webhooks/stripe` processes one-time PaymentIntent events. After signature handling, a valid delivery is claimed by the unique `PaymentEvent.stripeEventId` boundary. The claim, Payment resolution, state transitions, winner-gated entitlement activation, and final event outcome are committed atomically.

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
| `status` | String | Canonical: `created` \| `pending` \| `processing` \| `succeeded` \| `failed` \| `canceled`; legacy persisted success values may still be `completed` or `processed` pending migration |
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

Migrations: forward `Backend/prisma/migrations/20260720230001_payment_audit_trail/migration.sql`, reverse `.../down.sql` (also mirrored under `Backend/db/migrations/`).
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
