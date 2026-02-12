-- CreateTable
CREATE TABLE "ride_share_tokens" (
    "id" TEXT NOT NULL,
    "rideId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ride_share_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ride_share_tokens_token_key" ON "ride_share_tokens"("token");

-- AddForeignKey
ALTER TABLE "ride_share_tokens" ADD CONSTRAINT "ride_share_tokens_rideId_fkey" FOREIGN KEY ("rideId") REFERENCES "rides"("id") ON DELETE CASCADE ON UPDATE CASCADE;
