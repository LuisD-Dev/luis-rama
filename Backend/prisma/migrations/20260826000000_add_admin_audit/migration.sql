-- Add user lifecycle status used by administrative actions
ALTER TABLE "users" ADD COLUMN "status" TEXT DEFAULT 'active';

CREATE TABLE "admin_audit_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actor_user_id" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "request_id" TEXT,
    "ip_hash" TEXT,
    "before_json" TEXT,
    "after_json" TEXT,
    "prev_hash" TEXT NOT NULL,
    "entry_hash" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "admin_audit_events_entry_hash_key" ON "admin_audit_events"("entry_hash");
CREATE INDEX "admin_audit_events_actor_user_id_created_at_idx" ON "admin_audit_events"("actor_user_id", "created_at");
CREATE INDEX "admin_audit_events_target_type_target_id_idx" ON "admin_audit_events"("target_type", "target_id");
