-- Unify legacy identity fields (`name` pretty label + `username` handle)
-- into a single `nickname` column. Data-preserving: nickname prefers the
-- non-empty legacy `name` when it is unique among names, otherwise falls
-- back to the (guaranteed-unique) legacy `username`. No user is lost.

CREATE TABLE "new_users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nickname" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "recoveryCodeHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "avatarUrl" TEXT,
    "bio" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

INSERT INTO "new_users" (
    "id", "nickname", "passwordHash", "recoveryCodeHash", "role",
    "avatarUrl", "bio", "createdAt", "updatedAt"
)
SELECT
    "id",
    -- Nicknames are stored normalized (lowercase, trimmed) so lookups via
    -- normalizeNickname() match, exactly like legacy usernames did.
    CASE
        WHEN "name" IS NOT NULL
            AND TRIM("name") <> ''
            AND (SELECT COUNT(*) FROM "users" u
                 WHERE LOWER(TRIM(u."name")) = LOWER(TRIM("users"."name"))) = 1
            THEN LOWER(TRIM("name"))
        ELSE "username"
    END,
    "passwordHash",
    "recoveryCodeHash",
    "role",
    "avatarUrl",
    "bio",
    "createdAt",
    "updatedAt"
FROM "users";

DROP TABLE "users";
ALTER TABLE "new_users" RENAME TO "users";
CREATE UNIQUE INDEX "users_nickname_key" ON "users"("nickname");
CREATE INDEX "users_nickname_idx" ON "users"("nickname");
