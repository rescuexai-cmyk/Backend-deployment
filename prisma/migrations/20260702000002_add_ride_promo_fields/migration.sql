-- Booking-time promo/coupon applied to a ride. The discount is already baked
-- into totalFare; discountAmount records how much was taken off for reporting.

ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "promoCode" TEXT;
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "promoId" TEXT;
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "discountAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;
