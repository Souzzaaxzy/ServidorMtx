-- Profile music: the song a user pins to their profile (Instagram-style).
--
-- WHY: profiles should be able to play a short excerpt of a song. The audio
-- is stored on this server (an excerpt only, <= 1 minute) and the profile
-- plays it on demand.
--
-- Purely additive: one new table, no existing table or column touched. The
-- userId is the PRIMARY KEY on purpose — it enforces "one song per profile"
-- in the database itself, so the service cannot accumulate rows by mistake.
CREATE TABLE "profile_music" (
    "userId"     TEXT NOT NULL PRIMARY KEY,
    "title"      TEXT NOT NULL,
    "artist"     TEXT NOT NULL,
    "coverUrl"   TEXT,
    "audioUrl"   TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "startMs"    INTEGER NOT NULL DEFAULT 0,
    "sourceId"   TEXT NOT NULL,
    "sourceUrl"  TEXT NOT NULL,
    "createdAt"  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  DATETIME NOT NULL,
    CONSTRAINT "profile_music_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
