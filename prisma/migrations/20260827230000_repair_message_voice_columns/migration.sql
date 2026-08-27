-- Repair voice-message columns dropped by `20260827135123_deletion_system`.
--
-- Migration history:
--   - `20260827080000_audio_messages`   ADD COLUMN type/audioUrl/durationMs on messages
--   - `20260827135123_deletion_system`  RECREATED "messages" (drop+rename) WITHOUT those
--                                        columns, so voice messages broke with
--                                        "no such column" (500 on chat send/load).
--
-- This migration re-adds the columns. It applies both to databases that ran
-- the broken history (production/dev) and to fresh installs (the broken
-- history still recreates the table without them, then this repair runs
-- after and restores them). Do NOT "fix" 20260827135123 retroactively:
-- fresh installs would then have the columns already and this file would
-- fail with duplicate-column errors.

-- AlterTable (add nullable columns back)
ALTER TABLE "messages" ADD COLUMN "type" TEXT;
ALTER TABLE "messages" ADD COLUMN "audioUrl" TEXT;
ALTER TABLE "messages" ADD COLUMN "durationMs" INTEGER;