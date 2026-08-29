# Admin audit log

Administrative student and content mutations write one append-only `AdminAuditEvent` in the same Prisma transaction as the database mutation. Each row stores `prevHash` and `entryHash`; the latter is SHA-256 of `prevHash` plus the canonical payload. The first row uses 64 zeroes as its previous hash.

Apply the migration with `npm run prisma:deploy` (or `npm run prisma:migrate` locally), then verify the chain with:

```bash
npm run audit:verify
```

The command exits with status 1 and identifies the first broken row if a stored payload, link, or entry hash has changed. Requests receive an `X-Request-Id` response header; supplied IDs are preserved (up to 128 characters) and generated otherwise. Client IPs are salted and hashed using `AUDIT_IP_SALT`.

Admins can read recent events at `GET /api/admin/audit?page=1&limit=25`, with optional `action`, `targetType`, `targetId`, and `actorUserId` filters. `GET /api/admin/audit/verify` exposes the same integrity check to admins.