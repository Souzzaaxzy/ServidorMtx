-- Add SHA-256 hash for user-imported stickers (dedupe on Android share).
ALTER TABLE "stickers" ADD COLUMN "hash" TEXT;
CREATE INDEX "stickers_hash_idx" ON "stickers"("hash");