// ──────────────────────────────────────────────────────────────
// Message retention — the server keeps a DELIVERY QUEUE, not an archive.
//
// WHY
// Chat history now lives on each phone (see the app's local message store).
// The server's only remaining job for a message is to get it to the other
// participants; once that is done the copy is dead weight. Before this module
// the server kept EVERY message forever and nothing ever deleted anything
// (deleting a conversation or a message only flipped flags), so the database
// and the uploads directory grew without bound.
//
// The rules here are deliberately conservative, because deleting a message
// that was never delivered would lose it for good:
//   1. DELIVERED + older than the retention window → safe to drop. "Delivered"
//      means every other participant has read past it (the existing read
//      tracking already records that).
//   2. UNDELIVERED but older than the safety window → dropped too, otherwise a
//      permanently offline device would pin messages forever. The window is
//      long enough that a phone can be off for a while and still sync.
//   3. Media files referenced by a dropped message are deleted from disk, but
//      ONLY when no surviving message still references the same URL — two
//      chats can legitimately share one uploaded file.
//
// Everything is time-boxed and best-effort: a failure is logged and retried on
// the next run, never surfaced to the user.
// ──────────────────────────────────────────────────────────────

import { prisma } from '../../config/prisma.js';
import { deleteLocalFileByUrl } from '../uploads/upload.service.js';

/** Messages delivered to everyone are dropped after this long. */
export const DELIVERED_RETENTION_MS =
  Number(process.env.MESSAGE_RETENTION_MS ?? 7 * 24 * 60 * 60 * 1000); // 7d

/** Undelivered messages are kept at least this long (offline devices). */
export const UNDELIVERED_RETENTION_MS =
  Number(process.env.MESSAGE_UNDELIVERED_RETENTION_MS ?? 30 * 24 * 60 * 60 * 1000); // 30d

/** Upper bound of rows examined per run, so one sweep can never hog the DB. */
const BATCH = Number(process.env.MESSAGE_PURGE_BATCH ?? 500);

/** The media columns a message can point at (all deleted together). */
const MEDIA_COLUMNS = ['audioUrl', 'imageUrl', 'videoUrl', 'stickerUrl'] as const;

export interface PurgeResult {
  delivered: number;
  undelivered: number;
  filesDeleted: number;
}

/**
 * Deletes messages whose delivery job is finished, plus the media files that
 * become unreferenced as a result.
 *
 * Safe to run repeatedly and concurrently-ish: it only ever removes rows older
 * than the windows above, and each media file is re-checked for other
 * references before being unlinked.
 */
export async function purgeDeliveredMessages(): Promise<PurgeResult> {
  const now = Date.now();
  const deliveredBefore = new Date(now - DELIVERED_RETENTION_MS);
  const undeliveredBefore = new Date(now - UNDELIVERED_RETENTION_MS);

  // ── 1. Messages everyone has already read, past the retention window ──
  //
  // A DIRECT message counts as delivered when the recipient read it. A GROUP
  // message counts as delivered when every ACTIVE member has a read marker
  // (the app writes one per member on open).
  const delivered = await prisma.message.findMany({
    where: {
      createdAt: { lt: deliveredBefore },
      deletedAt: null,
      OR: [
        // DM: read by the other side.
        { conversationId: { not: null }, readAt: { not: null } },
        // Group: at least one reader marker (checked more strictly below).
        { groupId: { not: null }, readBy: { some: {} } },
      ],
    },
    select: {
      id: true,
      senderId: true,
      groupId: true,
      audioUrl: true,
      imageUrl: true,
      videoUrl: true,
      stickerUrl: true,
      group: { select: { members: { where: { bannedAt: null }, select: { userId: true } } } },
      readBy: { select: { userId: true } },
    },
    take: BATCH,
  });

  const trulyDelivered = delivered.filter((m) => {
    if (m.groupId === null) return true; // DM: the recipient read it.
    const members = new Set(m.group!.members.map((x) => x.userId));
    const readers = new Set(m.readBy.map((x) => x.userId));
    // Every active member must have read it. The SENDER is excluded: they
    // wrote it, so they never produce a read marker for their own message —
    // requiring one would keep every group message alive forever.
    members.delete(m.senderId);
    if (members.size === 0) return true; // nobody else to deliver to
    for (const member of members) {
      if (!readers.has(member)) return false;
    }
    return true;
  });

  // ── 2. Undelivered messages older than the safety window ──
  const undelivered = await prisma.message.findMany({
    where: {
      createdAt: { lt: undeliveredBefore },
      deletedAt: null,
      id: { notIn: trulyDelivered.map((m) => m.id) },
      OR: [
        { conversationId: { not: null }, readAt: null },
        { groupId: { not: null }, readBy: { none: {} } },
      ],
    },
    select: {
      id: true,
      audioUrl: true,
      imageUrl: true,
      videoUrl: true,
      stickerUrl: true,
    },
    take: BATCH,
  });

  const doomed = [...trulyDelivered, ...undelivered];
  if (doomed.length === 0) {
    return { delivered: 0, undelivered: 0, filesDeleted: 0 };
  }

  // Collect the media URLs BEFORE deleting the rows — once the rows are gone
  // there is no way to know which files they pointed at.
  const candidateUrls = new Set<string>();
  for (const m of doomed) {
    for (const col of MEDIA_COLUMNS) {
      const url = (m as Record<string, unknown>)[col];
      if (typeof url === 'string' && url.length > 0) candidateUrls.add(url);
    }
  }

  const ids = doomed.map((m) => m.id);

  // The join rows (hides / reads / mentions) cascade from the message, but
  // SQLite needs the pragma ON to honour that — Prisma enables it, so the
  // deletes below are enough.
  await prisma.message.deleteMany({ where: { id: { in: ids } } });

  // ── 3. Delete media files that nothing references any more ──
  let filesDeleted = 0;
  for (const url of candidateUrls) {
    const stillUsed = await prisma.message.findFirst({
      where: {
        OR: MEDIA_COLUMNS.map((col) => ({ [col]: url }) as never),
      },
      select: { id: true },
    });
    if (stillUsed) continue; // another surviving message still needs this file
    await deleteLocalFileByUrl(url);
    filesDeleted++;
  }

  return {
    delivered: trulyDelivered.length,
    undelivered: undelivered.length,
    filesDeleted,
  };
}
