-- Public sequential identifier (`#00000001`) for every account.
--
-- Requirements this migration must satisfy:
--   * existing users keep EVERY field (the users table is rebuilt, so all
--     columns are copied verbatim);
--   * existing users get a number too (ordered by createdAt, so the oldest
--     account becomes #00000001) — never a NULL, the column is NOT NULL;
--   * numbers are NEVER reused: allocation reads `user_ids`, which only ever
--     moves forward (a deleted account's number stays retired).
--
-- `user_ids` holds a single row with the LAST allocated number. The next
-- allocation increments it first, so the first account gets 1 (#00000001).

-- 1) Allocation table.
CREATE TABLE "user_ids" (
    "next" INTEGER NOT NULL
);

-- 2) Add the column to the existing table (plain ADD COLUMN keeps all data).
ALTER TABLE "users" ADD COLUMN "publicId" INTEGER;

-- 3) Number the accounts that already exist, oldest first, so the sequence
--    matches the creation order. `row_number()` is 1-based → #00000001 is the
--    oldest account.
UPDATE "users"
SET "publicId" = (
    SELECT "rn" FROM (
        SELECT "id", ROW_NUMBER() OVER (ORDER BY "createdAt" ASC, "id" ASC) AS "rn"
        FROM "users"
    ) AS "numbered"
    WHERE "numbered"."id" = "users"."id"
);

-- 4) Seed the allocator with the highest number just assigned (0 when the
--    table is empty, so the first registration receives 1).
INSERT INTO "user_ids" ("next")
SELECT COALESCE(MAX("publicId"), 0) FROM "users";

-- 5) Enforce the invariants. SQLite cannot add NOT NULL/UNIQUE to an existing
--    column in place, so the table is rebuilt — copying every column, which
--    preserves all rows and all other constraints exactly as they were.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "publicId" INTEGER NOT NULL,
    "nickname" TEXT NOT NULL,
    "nicknameKey" TEXT NOT NULL DEFAULT '',
    "passwordHash" TEXT NOT NULL,
    "recoveryCodeHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "avatarUrl" TEXT,
    "bannerUrl" TEXT,
    "bio" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

INSERT INTO "new_users" (
    "id", "publicId", "nickname", "nicknameKey", "passwordHash",
    "recoveryCodeHash", "role", "avatarUrl", "bannerUrl", "bio",
    "createdAt", "updatedAt"
)
SELECT
    "id", "publicId", "nickname", "nicknameKey", "passwordHash",
    "recoveryCodeHash", "role", "avatarUrl", "bannerUrl", "bio",
    "createdAt", "updatedAt"
FROM "users";

DROP TABLE "users";
ALTER TABLE "new_users" RENAME TO "users";

-- Recreate the original indexes plus the new unique one.
CREATE UNIQUE INDEX "users_nickname_key" ON "users"("nickname");
CREATE UNIQUE INDEX "users_nicknameKey_key" ON "users"("nicknameKey");
CREATE UNIQUE INDEX "users_publicId_key" ON "users"("publicId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
