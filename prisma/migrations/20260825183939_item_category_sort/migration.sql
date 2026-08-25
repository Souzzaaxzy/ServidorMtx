-- Extend the cosmetic catalog with a grouping key and an explicit display
-- order (used by the NAME_COLOR palette; both are optional for other types).
ALTER TABLE "items" ADD COLUMN "category" TEXT;
ALTER TABLE "items" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;
