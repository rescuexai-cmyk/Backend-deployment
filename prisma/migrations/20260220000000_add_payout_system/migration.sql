-- CreateEnum
CREATE TYPE "PayoutAccountType" AS ENUM ('BANK_ACCOUNT', 'UPI');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'REVERSED');

-- CreateEnum
CREATE TYPE "WalletTransactionType" AS ENUM ('RIDE_EARNING', 'WITHDRAWAL', 'PENALTY', 'PENALTY_REVERSAL', 'ADJUSTMENT', 'SETTLEMENT', 'HOLD', 'RELEASE', 'REFUND');

-- CreateTable
CREATE TABLE "driver_payout_accounts" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "accountType" "PayoutAccountType" NOT NULL,
    "bankName" TEXT,
    "accountNumber" TEXT,
    "accountNumberEncrypted" TEXT,
    "ifscCode" TEXT,
    "accountHolderName" TEXT,
    "upiId" TEXT,
    "razorpayContactId" TEXT,
    "razorpayFundAccountId" TEXT,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "verificationMethod" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "driver_payout_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_wallets" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "availableBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "pendingBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "holdBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalWithdrawn" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalEarned" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastSettlementAt" TIMESTAMP(3),
    "lastPayoutAt" TIMESTAMP(3),
    "minimumWithdrawal" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "driver_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_payouts" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "payoutAccountId" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "fee" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netAmount" DOUBLE PRECISION NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "payoutMethod" "PayoutAccountType" NOT NULL,
    "razorpayPayoutId" TEXT,
    "transactionId" TEXT,
    "failureReason" TEXT,
    "failureCode" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "remarks" TEXT,
    "isAutoSettlement" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "driver_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_transactions" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "type" "WalletTransactionType" NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "balanceBefore" DOUBLE PRECISION NOT NULL,
    "balanceAfter" DOUBLE PRECISION NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "driver_wallets_driverId_key" ON "driver_wallets"("driverId");

-- CreateIndex
CREATE INDEX "driver_payout_accounts_driverId_idx" ON "driver_payout_accounts"("driverId");

-- CreateIndex
CREATE INDEX "driver_payout_accounts_isPrimary_idx" ON "driver_payout_accounts"("isPrimary");

-- CreateIndex
CREATE INDEX "driver_payouts_driverId_idx" ON "driver_payouts"("driverId");

-- CreateIndex
CREATE INDEX "driver_payouts_status_idx" ON "driver_payouts"("status");

-- CreateIndex
CREATE INDEX "driver_payouts_requestedAt_idx" ON "driver_payouts"("requestedAt");

-- CreateIndex
CREATE INDEX "driver_payouts_isAutoSettlement_idx" ON "driver_payouts"("isAutoSettlement");

-- CreateIndex
CREATE INDEX "wallet_transactions_driverId_idx" ON "wallet_transactions"("driverId");

-- CreateIndex
CREATE INDEX "wallet_transactions_type_idx" ON "wallet_transactions"("type");

-- CreateIndex
CREATE INDEX "wallet_transactions_createdAt_idx" ON "wallet_transactions"("createdAt");

-- CreateIndex
CREATE INDEX "wallet_transactions_referenceType_referenceId_idx" ON "wallet_transactions"("referenceType", "referenceId");

-- AddForeignKey
ALTER TABLE "driver_payout_accounts" ADD CONSTRAINT "driver_payout_accounts_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_wallets" ADD CONSTRAINT "driver_wallets_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_payouts" ADD CONSTRAINT "driver_payouts_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_payouts" ADD CONSTRAINT "driver_payouts_payoutAccountId_fkey" FOREIGN KEY ("payoutAccountId") REFERENCES "driver_payout_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
