# Migración Render → Vercel (Teclia Academia)

Guía para desplegar **frontend + backend API** en Vercel usando la misma base de datos y storage que ya tienes en producción.

## Qué hace Vercel en este proyecto

| Componente | En Render (actual) | En Vercel (nuevo) |
|------------|-------------------|-------------------|
| Frontend React/Vite | Servicio web | Static + SPA (`dist/`) |
| Backend Express | Servicio Node persistente | Serverless (`api/index.js`) |
| Base de datos | Supabase / Postgres (Render) | **La misma** — no se mueve si reutilizas `DATABASE_URL` |
| Archivos subidos | Supabase Storage (recomendado) | **La misma** — `LOCAL_UPLOADS=false` |
| Stripe webhooks | URL de Render | Nueva URL en Vercel |

## Lo que ya está preparado en el repo

- `vercel.json` — build, rewrites `/api/*` → función serverless, SPA fallback
- `api/index.js` — entrypoint serverless del backend Express
- `src/services/api.js` — usa `VITE_API_BASE_URL` (en prod Vercel: `/api`)
- `npm run build:vercel` — `prisma generate` + `migrate deploy` + `vite build`

## ¿Necesitas pasarme variables de entorno?

**No me las pegues en el chat** (son secretos). Configúralas en:

**Vercel → Project → Settings → Environment Variables**

### Frontend (prefijo `VITE_`)

| Variable | Valor en Vercel | Notas |
|----------|-----------------|-------|
| `VITE_API_BASE_URL` | `/api` | Misma URL que el frontend |
| `VITE_STRIPE_PUBLISHABLE_KEY` | `pk_live_...` o `pk_test_...` | Igual que en Render |
| `VITE_PAYMENTS_ENABLED` | `true` | Si pagos activos |

### Backend (sin prefijo `VITE_`)

Copia desde Render / Supabase / Stripe:

| Variable | Obligatoria | Origen |
|----------|-------------|--------|
| `DATABASE_URL` | Sí | Supabase → Settings → Database → connection string |
| `JWT_SECRET` | Sí | El mismo que usas en Render |
| `SUPABASE_URL` | Sí (uploads) | Supabase project URL |
| `SUPABASE_SERVICE_KEY` o `SUPABASE_SERVICE_ROLE_KEY` | Sí | Supabase service role |
| `SUPABASE_BUCKET` | Sí | ej. `uploads` |
| `STRIPE_SECRET_KEY` | Sí (pagos) | Stripe Dashboard |
| `STRIPE_WEBHOOK_SECRET` | Sí (webhooks) | Stripe → nuevo endpoint Vercel |
| `SENDGRID_API_KEY` | Si usas email | SendGrid |
| `EMAIL_FROM` | Si usas email | |
| `LOCAL_UPLOADS` | **`false`** | Obligatorio en Vercel |
| `NODE_ENV` | `production` | |
| `CORS_ORIGIN` | `https://tu-dominio.vercel.app` | Tu dominio final |

## Base de datos — ¿hay que migrar?

**Caso A — Ya usas Supabase Postgres (recomendado)**  
No migres datos. Usa el **mismo** `DATABASE_URL` en Vercel. Solo corre migraciones en el build (`prisma migrate deploy`).

**Caso B — Postgres solo en Render**  
1. Exporta: `pg_dump $RENDER_DATABASE_URL > backup.sql`  
2. Importa en Supabase o [Vercel Postgres](https://vercel.com/docs/storage/vercel-postgres)  
3. Pon el nuevo `DATABASE_URL` en Vercel  

**Caso C — SQLite local**  
No sirve para producción serverless. Migra a Postgres antes de Vercel.

## Pasos en Vercel (dashboard)

1. [vercel.com/new](https://vercel.com/new) → Import `Teclia-Academy/Teclia-Academy`
2. **Root Directory:** `.` (raíz del repo)
3. **Framework Preset:** Vite (auto-detectado)
4. Añade todas las env vars de arriba (Production)
5. Deploy

## Después del primer deploy

1. **Stripe webhook**  
   - URL: `https://<tu-proyecto>.vercel.app/api/webhooks/stripe`  
   - Copia el signing secret → `STRIPE_WEBHOOK_SECRET` en Vercel → Redeploy

2. **Dominio custom** (opcional)  
   - Vercel → Domains → añade `tecliaacademy.com` o similar  
   - Actualiza `CORS_ORIGIN` y CSP si hace falta

3. **Apagar Render** solo cuando verifiques:
   - Login / signup
   - Subida de contenido (admin)
   - Checkout Stripe
   - Webhook de pago

## Límites de Vercel a tener en cuenta

- Funciones serverless: **max 30s** por request (configurado en `vercel.json`)
- **No** hay disco persistente → uploads locales desactivados
- Cold starts: primera petición API puede tardar ~1–3s

## Desarrollo local (sin Render)

```bash
# Terminal 1 — backend
cd Backend && npm run dev

# Terminal 2 — frontend (proxy /api → localhost:3001)
npm run dev
```

`.env` en raíz:

```env
VITE_API_BASE_URL=http://localhost:3001/api
```

## Checklist rápido

- [ ] `DATABASE_URL` apunta a Postgres accesible desde internet
- [ ] `LOCAL_UPLOADS=false` + Supabase configurado
- [ ] `JWT_SECRET` igual al de Render (usuarios no pierden sesión)
- [ ] Stripe webhook apunta a Vercel
- [ ] `VITE_API_BASE_URL=/api` en Production
- [ ] Smoke test completo antes de apagar Render
