-- Mention token ranges: anchors each message_mention to the exact
-- "@Nickname"/"@todos" range inside the message content so a mention is
-- NEVER inferred from text coincidence. Existing rows keep NULL (best-effort
-- rendering fallback on the client).
ALTER TABLE "message_mentions" ADD COLUMN "rangeStart" INTEGER;
ALTER TABLE "message_mentions" ADD COLUMN "rangeEnd" INTEGER;