-- CreateEnum
CREATE TYPE "PenaltyStatus" AS ENUM ('PENDING', 'PAID');

-- CreateTable
CREATE TABLE "driver_penalties" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "PenaltyStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "driver_penalties_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "driver_penalties" ADD CONSTRAINT "driver_penalties_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
