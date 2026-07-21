-- Payment audit trail: provider/metadata/external_id, subscriptions, payment_events reshape

-- AlterTable: payments
ALTER TABLE "payments" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'stripe';
ALTER TABLE "payments" ADD COLUMN "external_id" TEXT;
ALTER TABLE "payments" ADD COLUMN "metadata" TEXT;

-- Backfill external_id from Stripe identifiers when present
UPDATE "payments"
SET "external_id" = COALESCE("stripe_payment_intent_id", "stripe_checkout_session_id")
WHERE "external_id" IS NULL;

-- CreateIndex
CREATE INDEX "payments_user_id_created_at_idx" ON "payments"("user_id", "created_at");

-- CreateTable: subscriptions
CREATE TABLE "subscriptions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "plan_tier" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "external_id" TEXT NOT NULL,
    "current_period_start" DATETIME NOT NULL,
    "current_period_end" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "subscriptions_provider_external_id_key" ON "subscriptions"("provider", "external_id");
CREATE INDEX "subscriptions_user_id_idx" ON "subscriptions"("user_id");

-- Reshape payment_events (SQLite: rebuild table for rename + constraint changes)
CREATE TABLE "payment_events_new" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "payment_id" INTEGER,
    "type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "processed_at" DATETIME,
    "idempotency_key" TEXT NOT NULL,
    "stripe_event_id" TEXT,
    "outcome" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_events_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "payment_events_new" (
    "id",
    "payment_id",
    "type",
    "payload",
    "processed_at",
    "idempotency_key",
    "stripe_event_id",
    "outcome",
    "created_at"
)
SELECT
    "id",
    "payment_id",
    "event_type",
    "payload",
    "processed_at",
    COALESCE(
        NULLIF("idempotency_key", ''),
        'legacy_' || "id" || '_' || "stripe_event_id"
    ),
    "stripe_event_id",
    "outcome",
    "created_at"
FROM "payment_events";

DROP TABLE "payment_events";
ALTER TABLE "payment_events_new" RENAME TO "payment_events";

CREATE UNIQUE INDEX "payment_events_idempotency_key_key" ON "payment_events"("idempotency_key");
CREATE UNIQUE INDEX "payment_events_stripe_event_id_key" ON "payment_events"("stripe_event_id");
