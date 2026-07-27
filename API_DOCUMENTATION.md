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
