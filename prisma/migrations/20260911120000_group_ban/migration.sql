-- Group bans: track when a member is banned from a group (soft-remove).
-- The row is kept (audit + re-add later); all read/write paths filter on
-- bannedAt NULL; the OWNER can never be banned (server-enforced.

-- AlterTable
ALTER TABLE "group_members" ADD COLUMN "bannedAt" DATETIME;

-- AlterTable
ALTER TABLE "group_members" ADD COLUMN "bannedById" TEXT;

