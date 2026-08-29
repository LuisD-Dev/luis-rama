-- CreateTable
CREATE TABLE "payments" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "plan_tier" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "status" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "stripe_payment_intent_id" TEXT,
    "stripe_payment_method_id" TEXT,
    "client_message" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "payments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "payments_user_id_idempotency_key_key" ON "payments"("user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "payments_user_id_idx" ON "payments"("user_id");
