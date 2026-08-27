-- Voice messages on the private chat. Non-null `type` marks a message as a
-- voice message; `content` then holds the stable preview "🎤 Áudio",
-- `audioUrl` the persisted file URL and `durationMs` the recorded length.
-- Text messages leave all three NULL.

-- AlterTable (add nullable columns)
ALTER TABLE "messages" ADD COLUMN "type" TEXT;
ALTER TABLE "messages" ADD COLUMN "audioUrl" TEXT;
ALTER TABLE "messages" ADD COLUMN "durationMs" INTEGER;