# Backend Changes Required for Frontend Integration

This document details every backend change needed to support the new frontend features. All changes are **frontend-facing only** — no business logic changes required beyond what is listed.

---

## Table of Contents

1. [New API Routes](#1-new-api-routes)
2. [Database Model Changes](#2-database-model-changes)
3. [Validation Schema Changes](#3-validation-schema-changes)
4. [Middleware Changes](#4-middleware-changes)
5. [Configuration Changes](#5-configuration-changes)
6. [Security Fixes](#6-security-fixes)
7. [Optional Enhancements](#7-optional-enhancements)
8. [Summary of All Endpoints](#8-summary-of-all-endpoints)

---

## 1. New API Routes

### 1.1 `PATCH /api/admin/users/:id/status` — Update Student Status

**Purpose:** Suspend or reactivate a student account.

**File to create/modify:** `routes/admin.js` (new file) or add to `routes/auth.js`

**Request:**
```
PATCH /api/admin/users/:id/status
Authorization: Bearer <token>
Content-Type: application/json

{
  "status": "suspended" | "active" | "inactive"
}
```

**Middleware:** `verifyToken`, `adminOnly`

**Controller function (add to `controllers/authController.js` or new `controllers/adminController.js`):**

```javascript
export const updateStudentStatus = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const validStatuses = ['active', 'inactive', 'suspended'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Estado no válido. Use: active, inactive, suspended' });
  }

  const user = await prisma.user.update({
    where: { id: Number(id) },
    data: { status },
  });

  res.json({
    message: status === 'suspended'
      ? 'Estudiante suspendido correctamente'
      : `Estado actualizado a ${status}`,
    user: formatUser(user),
  });
};
```

**Response (200):**
```json
{
  "message": "Estudiante suspendido correctamente",
  "user": { "id": 1, "name": "...", "email": "...", "status": "suspended", ... }
}
```

**Response (404):**
```json
{ "error": "Usuario no encontrado" }
```

---

### 1.2 `GET /api/admin/stats` — Dashboard Statistics

**Purpose:** Return comprehensive admin dashboard statistics.

**File to create/modify:** `routes/admin.js` or `controllers/statsController.js`

**Request:**
```
GET /api/admin/stats
Authorization: Bearer <token>
```

**Middleware:** `verifyToken`, `adminOnly`

**Controller function (add to `controllers/statsController.js`):**

```javascript
export const getAdminStats = async (req, res) => {
  const totalStudents = await prisma.user.count({
    where: { role: { not: 'admin' } },
  });

  const activeStudents = await prisma.user.count({
    where: { role: { not: 'admin' }, status: 'active' },
  });

  const totalTeachers = await prisma.user.count({
    where: { role: 'teacher' },
  });

  const activeCourses = await prisma.content.count({
    where: { status: 'published' },
  });

  const now = new Date();
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const newRegistrations = await prisma.user.count({
    where: {
      role: { not: 'admin' },
      createdAt: { gte: firstOfMonth },
    },
  });

  const pendingRequests = 0; // Placeholder — implement when a requests model exists

  // Revenue is now computed from completed payment records only.
  // Use `paidAt` when available, otherwise fallback to `createdAt`.
  const revenueThisMonth = sumCompletedPaymentsForCurrentMonth();
  const revenueLastMonth = sumCompletedPaymentsForPreviousMonth();
  const revenueChange = revenueLastMonth > 0
    ? Number((((revenueThisMonth - revenueLastMonth) / revenueLastMonth) * 100).toFixed(2))
    : (revenueThisMonth > 0 ? 100 : 0);

  const activeSubscriptions = {
    basico: countUsersWhoseLatestCompletedPaymentIs('basico'),
    pro: countUsersWhoseLatestCompletedPaymentIs('pro'),
    master: countUsersWhoseLatestCompletedPaymentIs('master'),
  };

  res.json({
    totalStudents,
    activeStudents,
    totalTeachers,
    activeCourses,
    newRegistrations,
    pendingRequests,
    revenueThisMonth,
    revenueLastMonth,
    revenueChange,
    activeSubscriptions,
    currency: 'USD',
  });
};
```

Implementation status in this repository:

- `GET /api/admin/stats` is implemented in `controllers/statsController.js` and protected by `verifyToken` + `adminOnly`.
- Revenue metrics are calculated from `Payment` records with `status = 'completed'` only.
- Month-over-month comparison is based on current month vs previous month boundaries.
- Active subscriptions are grouped by plan tier from each user's latest completed payment.

**Mount in `app.js` (or `server.js`):**
```javascript
import adminRoutes from './routes/admin.js';
app.use('/api/admin', adminRoutes);
```

---

### 1.3 Route file: `routes/admin.js` (new file)

Create `Backend/routes/admin.js`:

```javascript
import { Router } from 'express';
import { verifyToken, adminOnly } from '../middleware/auth.js';
import { updateStudentStatus } from '../controllers/authController.js';
import { getAdminStats } from '../controllers/statsController.js';

const router = Router();

router.patch('/users/:id/status', verifyToken, adminOnly, updateStudentStatus);
router.get('/stats', verifyToken, adminOnly, getAdminStats);

export default router;
```

### 1.4 Payment completion status semantics

The frontend must use the canonical `status` returned by `POST /api/payments/payment-method`; an HTTP 200 response alone is not proof of completed payment.

| Payment status | Frontend behavior |
|---|---|
| `succeeded` | Show completed-payment UX |
| `pending` | Show a neutral processing state; do not show completion |
| `processing` | Show a neutral processing state; do not show completion |
| `failed` | Show failure UI |
| `canceled` | Show cancellation/failure UI |
| unknown or missing | Fail closed; never show success |

The current application has no payment polling/status retrieval endpoint. A screen that receives `pending` or `processing` therefore does not automatically advance to `succeeded` without another navigation or refresh mechanism.

---

## 2. Database Model Changes

### 2.1 Add `status` field to `User` model

**File:** `prisma/schema.prisma`

```prisma
model User {
  id            Int       @id @default(autoincrement())
  email         String    @unique
  passwordHash  String    @map("password_hash")
  name          String
  role          String?   @default("student")
  status        String?   @default("active")       // NEW: active, inactive, suspended, pending, graduated
  avatarUrl     String?   @map("avatar_url")
  resetPin      String?   @map("reset_pin")
  resetPinExpiresAt DateTime? @map("reset_pin_expires_at")
  planTier      String?   @map("plan_tier")
  createdAt     DateTime? @default(now()) @map("created_at")
  content       Content[]

  @@map("users")
}
```

**Migration command:**
```bash
npx prisma migrate dev --name add_user_status
```

**SQL (if manual):**
```sql
ALTER TABLE users ADD COLUMN status VARCHAR(20) DEFAULT 'active';
```

### 2.2 Add `status` field to `Content` model (optional — for draft/published)

```prisma
model Content {
  id          Int       @id @default(autoincrement())
  title       String
  description String?
  type        String
  url         String
  isFree      Int       @default(0) @map("is_free")
  planTier    String?   @default("free") @map("plan_tier")
  status      String?   @default("published")   // NEW: published, draft
  uploadedBy  Int       @map("uploaded_by")
  createdAt   DateTime? @default(now()) @map("created_at")
  uploader    User      @relation(fields: [uploadedBy], references: [id])

  @@map("content")
}
```

---

## 3. Validation Schema Changes

### 3.1 Password validation — require special characters

**File:** `utils/password.js` (backend)

```javascript
// Current (line 1-12):
export const validatePassword = (password) => {
  if (!password || password.length < 8) return 'La contraseña debe tener al menos 8 caracteres';
  if (!/[a-zA-ZáéíóúÁÉÍÓÚñÑ]/.test(password)) return 'La contraseña debe incluir letras';
  if (!/[0-9]/.test(password)) return 'La contraseña debe incluir números';
  return null;
};

// Change to:
export const validatePassword = (password) => {
  if (!password || password.length < 8) return 'La contraseña debe tener al menos 8 caracteres';
  if (!/[a-zA-ZáéíóúÁÉÍÓÚñÑ]/.test(password)) return 'La contraseña debe incluir letras';
  if (!/[0-9]/.test(password)) return 'La contraseña debe incluir números';
  if (!/[!@#$%^&*(),.?":{}|<>_\-]/.test(password)) return 'La contraseña debe incluir al menos un carácter especial';
  return null;
};
```

### 3.2 Auth schema — update password validation

**File:** `schemas/auth.schema.js`

Find the `register` schema and add the special character check:
```javascript
// Current password validation in schema:
password: z.string().min(8, 'Mínimo 8 caracteres'),

// Change to:
password: z.string()
  .min(8, 'Mínimo 8 caracteres')
  .regex(/[a-zA-ZáéíóúÁÉÍÓÚñÑ]/, 'Debe incluir letras')
  .regex(/[0-9]/, 'Debe incluir números')
  .regex(/[!@#$%^&*(),.?":{}|<>_\-]/, 'Debe incluir un carácter especial'),
```

Do the same for `resetPassword` schema's `newPassword` field.

---

## 4. Middleware Changes

### 4.1 CSRF Token Validation Middleware (optional but recommended)

**Create file:** `middleware/csrf.js`

```javascript
export const validateCsrfToken = (req, res, next) => {
  // Skip CSRF check for GET/HEAD/OPTIONS
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const csrfHeader = req.headers['x-csrf-token'];
  if (!csrfHeader) {
    return res.status(403).json({ error: 'Falta token CSRF' });
  }

  // TODO: In a fully secure implementation, validate against a stored session token
  // For now, we ensure the header is present (frontend always sends it)
  next();
};
```

**Apply in `app.js`:**
```javascript
import { validateCsrfToken } from './middleware/csrf.js';
app.use('/api', validateCsrfToken);
```

### 4.2 CORS — Restrict allowed origins

**File:** `app.js` and `server.js`

```javascript
// Current (open to all origins):
app.use(cors());

// Change to:
app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:4173',
    'https://teclia-academia-1.onrender.com',
    // Add your production domain
  ],
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
  credentials: true,
}));
```

### 4.3 Add `helmet` to `server.js`

**File:** `server.js`

```javascript
// Import at top:
import helmet from 'helmet';

// Apply after creating app:
app.use(helmet());
```

### 4.4 Update rate limiter limits

**File:** `middleware/rateLimiter.js`

```javascript
// Current: 100 req / 15 min
export const globalLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 100,
});

// Consider increasing for the dashboard which makes many requests:
export const adminLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 200,
});
```

---

## 5. Configuration Changes

### 5.1 Environment variable for JWT secret

**File:** `app.js` and `server.js`

```javascript
// CURRENT (hardcoded fallback):
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'teclia_dev_secret_change_this';
}

// CHANGE TO — require env var in production:
if (!process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: JWT_SECRET environment variable is not set');
    process.exit(1);
  } else {
    console.warn('WARNING: Using default JWT_SECRET for development only');
    process.env.JWT_SECRET = 'teclia_dev_secret_change_this';
  }
}
```

### 5.2 Remove hardcoded admin password from seed scripts

**File:** `prisma/seed.js` and `scripts/seeders/users.seeder.js`

```javascript
// CURRENT:
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || "Mondaisa2007*";

// CHANGE TO — always require via env:
if (!process.env.SEED_ADMIN_PASSWORD) {
  console.error('FATAL: SEED_ADMIN_PASSWORD environment variable must be set for seeding');
  process.exit(1);
}
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD;
```

---

## 6. Security Fixes

### 6.1 JWT secret hardcoded fallback

**Files:** `app.js:23`, `server.js:20`

Both files contain:
```javascript
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'teclia_dev_secret_change_this';
}
```

**Fix:** Remove the fallback or make it development-only (see §5.1 above).

### 6.2 CORS wide open

**Files:** `app.js:26`, `server.js:24`

Both use `app.use(cors())` with no options. **Fix:** Restrict origins (see §4.2 above).

### 6.3 `server.js` missing `helmet`

**File:** `server.js`

`app.js` uses `helmet()` but `server.js` does not. **Fix:** Add `helmet()` to `server.js` (see §4.3 above).

### 6.4 Hardcoded sender email

**File:** `controllers/authController.js`

```javascript
from: "austincomputadora@gmail.com",
```

**Fix:** Move to environment variable:
```javascript
from: process.env.EMAIL_FROM || "noreply@teclia.com",
```

### 6.5 Stored XSS in email content

**File:** `controllers/authController.js`

The PIN email builds HTML by interpolation:
```javascript
html: `<p>Tu código para restablecer la contraseña es: <strong>${pin}</strong>.</p>`,
```

The PIN is server-generated (6-digit numeric), so this is low risk. However, for a production pattern, use a proper HTML templating approach or at minimum add `encodeURIComponent` for any user-controlled data.

---

## 7. Optional Enhancements

### 7.1 Content type validation alignment

**File:** `schemas/content.schema.js`

The schema validates `type` as `video|article|quiz`, but the frontend sends `video|pdf|audio|image`. Align the backend to accept the frontend values:

```javascript
// Current:
type: z.enum(['video', 'article', 'quiz']),

// Change to:
type: z.enum(['video', 'pdf', 'audio', 'image']),
```

### 7.2 Free content authentication

**File:** `routes/content.js`

The `/free` endpoint requires `verifyToken`:
```javascript
router.get('/free', verifyToken, getFreeContent);
```

If free content should be accessible to unauthenticated users, remove `verifyToken`:
```javascript
router.get('/free', getFreeContent);
```

### 7.3 User serializer — include status field

**File:** `utils/serializers.js`

Update `formatUser` to include the new `status` field:
```javascript
export const formatUser = (user) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
  status: user.status || 'active',     // ADD THIS
  avatar_url: user.avatarUrl,
  plan_tier: user.planTier,
});
```

### 7.4 Student list — include status and extended fields

**File:** `controllers/authController.js` → `listStudents`

Update to return status alongside student data:
```javascript
export const listStudents = async (_req, res) => {
  const students = await prisma.user.findMany({
    where: { role: { not: 'admin' } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      status: true,         // ADD THIS
      avatarUrl: true,
      planTier: true,
      createdAt: true,
    }
  });

  res.json({
    students: students.map(formatUserWithCreatedAt),
  });
};
```

---

## 8. Summary of All Endpoints

### Frontend → Backend API Map

| Frontend Function | HTTP Method | Endpoint | Status |
|---|---|---|---|
| `authService.signup()` | `POST` | `/api/auth/signup` | ✅ Exists |
| `authService.login()` | `POST` | `/api/auth/login` | ✅ Exists |
| `authService.getStudents()` | `GET` | `/api/auth/students` | ✅ Exists — needs `status` field added |
| `authService.updateStudentPlan()` | `PATCH` | `/api/auth/students/:id/plan` | ✅ Exists |
| `authService.deleteStudent()` | `DELETE` | `/api/auth/students/:id` | ✅ Exists |
| **`authService.updateStudentStatus()`** | **`PATCH`** | **`/api/admin/users/:id/status`** | **🚫 NEW** |
| `adminService.getDashboardStats()` | `GET` | `/api/admin/stats` | **🚫 NEW** |
| `adminService.deleteContent()` | `DELETE` | `/api/content/:id` | ✅ Exists |
| `contentService.getContent()` | `GET` | `/api/content` | ✅ Exists |
| `statsService.getVisitStats()` | `GET` | `/api/stats/visits` | ✅ Exists |

---

## Migration Steps (Ordered)

1. **Run Prisma migration** to add `status` field to `users` table
2. **Update `utils/serializers.js`** — include `status` in `formatUser`
3. **Update `controllers/authController.js`** — add `updateStudentStatus` function
4. **Update `controllers/statsController.js`** — add `getAdminStats` function
5. **Create `routes/admin.js`** — new route file with status + stats endpoints
6. **Update `app.js`** — mount `/api/admin` routes, restrict CORS, add CSRF middleware
7. **Update `server.js`** — add `helmet()`, restrict CORS
8. **Update `utils/password.js`** — add special character validation
9. **Update `schemas/auth.schema.js`** — add special character regex to password fields
10. **Update `utils/jwt.js`** — remove or secure development fallback secret
11. **Update seed scripts** — remove hardcoded passwords, require env vars

---

## Frontend Branch for Testing

All frontend changes are on branch `admin-dashboard`. To test:

```bash
cd Teclia-Academy
git checkout admin-dashboard
npm install
npm run dev
```

Before testing with the backend, ensure these backend changes are complete, especially:
- `PATCH /api/admin/users/:id/status` (needed for suspend/reactivate)
- `status` field in `listStudents` response (needed for status badges)
