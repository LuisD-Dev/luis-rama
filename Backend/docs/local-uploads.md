# Local uploads mode

## Cómo activar modo local

Set `LOCAL_UPLOADS=true` in your environment before starting the backend.

Also set `MEDIA_SIGNING_SECRET` to a long random value. Paid content receives an HMAC-signed URL whose lifetime is controlled by `CONTENT_SIGNED_URL_TTL_SECONDS` (900 seconds by default, constrained to 300-900 seconds).

## Cómo volver a Supabase

Set `LOCAL_UPLOADS=false` (or remove the variable) and make sure your Supabase credentials are present.

## Estructura de carpetas

The backend stores files under:

- `Backend/uploads/<subfolder>/<filename>` for local mode

## Limitaciones

- Free content remains public after the backend confirms that its database record is free.
- Paid content is served only through `/api/media/signed`; direct `/uploads/content/*` access is blocked.
- A signed URL is a bearer credential and can be shared until it expires. It does not encrypt file bytes or provide offline caching.
- This mode is intended for local development and small test environments.

## Ejemplos

### Upload

```js
const storagePath = await storage.upload(req.file, 'courses');
```

### Retrieval

```js
const url = storage.resolveUrl(storagePath);
```

### Signed retrieval

```js
const url = await storage.resolveSignedUrl(storagePath, {
  expiresInSeconds: 900,
});
```

### Delete

```js
await storage.delete(storagePath);
```
