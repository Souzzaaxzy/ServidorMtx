-- Stories: ephemeral media (24h) reusing the existing upload/storage stack.
CREATE TABLE "stories" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "mediaUrl" TEXT NOT NULL,
  "mediaType" TEXT NOT NULL DEFAULT 'image',
  "thumbnailUrl" TEXT,
  "caption" TEXT NOT NULL DEFAULT '',
  "expiresAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stories_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "stories_userId_idx" ON "stories"("userId");
CREATE INDEX "stories_expiresAt_idx" ON "stories"("expiresAt");
CREATE INDEX "stories_createdAt_idx" ON "stories"("createdAt");

-- Per-user "seen" marker (discrete viewed/unviewed ring).
CREATE TABLE "story_views" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "storyId" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "story_views_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "story_views_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "stories" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "story_views_userId_storyId_key" ON "story_views"("userId", "storyId");
CREATE INDEX "story_views_userId_idx" ON "story_views"("userId");
