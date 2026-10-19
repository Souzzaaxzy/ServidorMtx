-- Delivery receipts: proof that a recipient's DEVICE stored the message.
--
-- WHY: the server keeps a message only until it reaches everyone (it is a
-- delivery queue, not an archive). "Reached everyone" used to mean "everyone
-- read it", but a chat nobody opens would then keep its messages forever.
-- A delivery receipt is written by the app as soon as the message is on the
-- phone — no need to open the chat — so the queue can be drained safely.
--
-- Purely additive: one new table. Existing rows and tables are untouched.
CREATE TABLE "message_deliveries" (
    "id"          TEXT NOT NULL PRIMARY KEY,
    "messageId"   TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    "deliveredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "message_deliveries_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "message_deliveries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- One receipt per (message, user): the app can re-send an ack freely
-- (retries, reconnects) without ever duplicating the row.
CREATE UNIQUE INDEX "message_deliveries_messageId_userId_key"
    ON "message_deliveries"("messageId", "userId");

CREATE INDEX "message_deliveries_userId_idx" ON "message_deliveries"("userId");
