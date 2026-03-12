-- Chat reliability + unread tracking
-- 1) Idempotent message writes via clientMessageId
-- 2) Per-ride unread/read cursor via lastReadAt + unreadCount

ALTER TABLE "ride_messages"
ADD COLUMN IF NOT EXISTS "clientMessageId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "ride_messages_rideId_senderId_clientMessageId_key"
ON "ride_messages"("rideId", "senderId", "clientMessageId");

CREATE TABLE IF NOT EXISTS "ride_chat_participants" (
  "id" TEXT PRIMARY KEY,
  "rideId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "lastReadAt" TIMESTAMP(3),
  "unreadCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ride_chat_participants_rideId_fkey"
    FOREIGN KEY ("rideId") REFERENCES "rides"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ride_chat_participants_rideId_userId_key"
ON "ride_chat_participants"("rideId", "userId");

CREATE INDEX IF NOT EXISTS "ride_chat_participants_rideId_idx"
ON "ride_chat_participants"("rideId");

CREATE INDEX IF NOT EXISTS "ride_chat_participants_userId_idx"
ON "ride_chat_participants"("userId");

CREATE INDEX IF NOT EXISTS "ride_chat_participants_rideId_userId_lastReadAt_idx"
ON "ride_chat_participants"("rideId", "userId", "lastReadAt");
