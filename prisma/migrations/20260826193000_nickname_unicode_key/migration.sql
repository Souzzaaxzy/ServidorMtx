-- Nickname Unicode support: the display `nickname` keeps the exact typed
-- form (mixed case, emojis, symbols); `nicknameKey` is the case-insensitive
-- lookup key used for uniqueness, login, recovery and profile resolution.
-- Existing rows are all-lowercase already, so lower(nickname) is a safe
-- backfill. No user data is deleted.

ALTER TABLE "users" ADD COLUMN "nicknameKey" TEXT NOT NULL DEFAULT '';

UPDATE "users" SET "nicknameKey" = lower("nickname");

CREATE UNIQUE INDEX "users_nicknameKey_key" ON "users"("nicknameKey");
