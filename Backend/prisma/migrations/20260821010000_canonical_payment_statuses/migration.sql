UPDATE "payments"
SET "status" = 'succeeded'
WHERE "status" IN ('processed', 'completed');
