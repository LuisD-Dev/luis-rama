-- AlterTable
ALTER TABLE "payments" ADD COLUMN "ip_hash" TEXT;

-- CreateTable
CREATE TABLE "risk_decisions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER,
    "ip_hash" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "signals_json" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "decision" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "risk_decisions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_users" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT DEFAULT 'student',
    "avatar_url" TEXT,
    "reset_pin" TEXT,
    "reset_pin_expires_at" DATETIME,
    "plan_tier" TEXT,
    "risk_whitelisted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_users" ("avatar_url", "created_at", "email", "id", "name", "password_hash", "plan_tier", "reset_pin", "reset_pin_expires_at", "role") SELECT "avatar_url", "created_at", "email", "id", "name", "password_hash", "plan_tier", "reset_pin", "reset_pin_expires_at", "role" FROM "users";
DROP TABLE "users";
ALTER TABLE "new_users" RENAME TO "users";
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;

-- CreateIndex
CREATE INDEX "risk_decisions_user_id_created_at_idx" ON "risk_decisions"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "risk_decisions_ip_hash_created_at_idx" ON "risk_decisions"("ip_hash", "created_at");

-- CreateIndex
CREATE INDEX "risk_decisions_decision_created_at_idx" ON "risk_decisions"("decision", "created_at");

-- CreateIndex
CREATE INDEX "payments_ip_hash_created_at_idx" ON "payments"("ip_hash", "created_at");

