-- Reply support on private chat messages. Only the REFERENCE to the
-- original message is stored (never the original content). onDelete: SetNull
-- so deleting the original does not cascade-delete replies — they degrade
-- to "sem mensagem original" at load time instead of disappearing.
-- AlterTable
ALTER TABLE "messages" ADD COLUMN "replyToMessageId" TEXT;

-- CreateIndex
CREATE INDEX "messages_replyToMessageId_idx" ON "messages"("replyToMessageId");