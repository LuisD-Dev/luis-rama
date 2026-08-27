-- Reversible down migration for 20260720230001_payment_audit_trail
-- Apply manually if rolling back: prisma migrate resolve / restore from this SQL

DROP INDEX IF EXISTS "subscriptions_user_id_idx";
DROP INDEX IF EXISTS "subscriptions_provider_external_id_key";
DROP TABLE IF EXISTS "subscriptions";

DROP INDEX IF EXISTS "payments_user_id_created_at_idx";

-- Restore legacy payment_events shape
CREATE TABLE "payment_events_legacy" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "stripe_event_id" TEXT NOT NULL,
    "payment_id" INTEGER,
    "idempotency_key" TEXT,
    "event_type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "processed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_events_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "payment_events_legacy" (
    "id",
    "stripe_event_id",
    "payment_id",
    "idempotency_key",
    "event_type",
    "payload",
    "outcome",
    "processed_at",
    "created_at"
)
SELECT
    "id",
    COALESCE("stripe_event_id", 'restored_' || "id"),
    "payment_id",
    "idempotency_key",
    "type",
    "payload",
    COALESCE("outcome", 'processed'),
    "processed_at",
    "created_at"
FROM "payment_events";

DROP TABLE "payment_events";
ALTER TABLE "payment_events_legacy" RENAME TO "payment_events";

CREATE UNIQUE INDEX "payment_events_stripe_event_id_key" ON "payment_events"("stripe_event_id");
CREATE UNIQUE INDEX "payment_events_idempotency_key_event_type_key" ON "payment_events"("idempotency_key", "event_type");

-- SQLite cannot DROP COLUMN before 3.35; recreate payments without new columns when needed.
-- For modern SQLite, drop additive columns:
-- ALTER TABLE "payments" DROP COLUMN "metadata";
-- ALTER TABLE "payments" DROP COLUMN "external_id";
-- ALTER TABLE "payments" DROP COLUMN "provider";
