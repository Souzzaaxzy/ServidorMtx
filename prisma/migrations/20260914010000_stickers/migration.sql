-- AlterTable: add sticker message columns
ALTER TABLE "messages" ADD COLUMN "stickerUrl" TEXT;
ALTER TABLE "messages" ADD COLUMN "stickerId" TEXT;
ALTER TABLE "messages" ADD COLUMN "stickerPackageId" TEXT;

-- CreateTable
CREATE TABLE "sticker_packages" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "author" TEXT NOT NULL DEFAULT 'MATRIX',
  "iconUrl" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "sticker_packages_slug_key" ON "sticker_packages"("slug");
CREATE INDEX "sticker_packages_active_idx" ON "sticker_packages"("active");

-- CreateTable
CREATE TABLE "stickers" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "packageId" TEXT NOT NULL,
  "order" INTEGER NOT NULL DEFAULT 0,
  "fileUrl" TEXT NOT NULL,
  "thumbUrl" TEXT,
  "width" INTEGER,
  "height" INTEGER,
  "authorId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stickers_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "sticker_packages" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "stickers_packageId_order_key" ON "stickers"("packageId", "order");
CREATE INDEX "stickers_packageId_idx" ON "stickers"("packageId");
CREATE INDEX "stickers_authorId_idx" ON "stickers"("authorId");

-- CreateTable
CREATE TABLE "user_sticker_packages" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "packageId" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_sticker_packages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "user_sticker_packages_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "sticker_packages" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "user_sticker_packages_userId_packageId_key" ON "user_sticker_packages"("userId", "packageId");
CREATE INDEX "user_sticker_packages_userId_idx" ON "user_sticker_packages"("userId");

-- CreateTable
CREATE TABLE "sticker_favorites" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "stickerId" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sticker_favorites_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sticker_favorites_stickerId_fkey" FOREIGN KEY ("stickerId") REFERENCES "stickers" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "sticker_favorites_userId_stickerId_key" ON "sticker_favorites"("userId", "stickerId");
CREATE INDEX "sticker_favorites_userId_idx" ON "sticker_favorites"("userId");

-- CreateTable
CREATE TABLE "sticker_recents" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "stickerId" TEXT NOT NULL,
  "usedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sticker_recents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sticker_recents_stickerId_fkey" FOREIGN KEY ("stickerId") REFERENCES "stickers" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "sticker_recents_userId_stickerId_key" ON "sticker_recents"("userId", "stickerId");
CREATE INDEX "sticker_recents_userId_usedAt_idx" ON "sticker_recents"("userId", "usedAt");