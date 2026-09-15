-- Stories: text stories + likes; chat messages: story-reply reference.
-- All plain ADD COLUMNs / a new table (no SQLite table rebuild).

-- 'image' | 'video' | 'text' — one row shape for every story kind.
ALTER TABLE "stories" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'image';
-- Text story content (empty for media stories).
ALTER TABLE "stories" ADD COLUMN "text" TEXT NOT NULL DEFAULT '';

-- A like on a story: same semantics as the post `Like` (unique per
-- user+story, so repeated taps can never duplicate).
CREATE TABLE "story_likes" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "storyId" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "story_likes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "story_likes_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "stories" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "story_likes_userId_storyId_key" ON "story_likes"("userId", "storyId");
CREATE INDEX "story_likes_storyId_idx" ON "story_likes"("storyId");

-- Story-reply chat messages carry the original story reference PLUS a
-- snapshot (type/thumbnail/text preview) so an EXPIRED story still renders
-- in the chat history without breaking the conversation.
ALTER TABLE "messages" ADD COLUMN "storyId" TEXT;
ALTER TABLE "messages" ADD COLUMN "storyType" TEXT;
ALTER TABLE "messages" ADD COLUMN "storyThumbUrl" TEXT;
ALTER TABLE "messages" ADD COLUMN "storyPreview" TEXT;
