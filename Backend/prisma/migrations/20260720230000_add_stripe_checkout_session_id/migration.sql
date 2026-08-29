-- AlterTable
ALTER TABLE "payments" ADD COLUMN "stripe_checkout_session_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "payments_stripe_checkout_session_id_key" ON "payments"("stripe_checkout_session_id");
