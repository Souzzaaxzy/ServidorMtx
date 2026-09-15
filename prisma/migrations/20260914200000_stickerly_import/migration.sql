-- Sticker.ly import: identify the owner + source of an imported package so
-- reimporting the same source pack is deduplicated (and user packages can be
-- deactivated without hiding the official catalog).
ALTER TABLE "sticker_packages" ADD COLUMN "authorId" TEXT;
ALTER TABLE "sticker_packages" ADD COLUMN "source" TEXT;
ALTER TABLE "sticker_packages" ADD COLUMN "sourceId" TEXT;

CREATE INDEX "sticker_packages_authorId_idx" ON "sticker_packages"("authorId");
CREATE INDEX "sticker_packages_source_sourceId_idx" ON "sticker_packages"("source", "sourceId");
