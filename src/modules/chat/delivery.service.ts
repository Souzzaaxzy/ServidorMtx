// ──────────────────────────────────────────────────────────────
// Delivery receipts — "this device HAS the message".
//
// WHY
// The server keeps a message only until it reaches every participant (chat
// history lives on the phones; see retention.service.ts). Deciding "reached
// everyone" from READ receipts was not enough: a conversation nobody opens
// never gets a read, so its messages would sit on the server forever.
//
// A delivery receipt is different from a read: the app writes it as soon as
// the message is stored on the device — the app can be in the background and
// the user may never look at it. That makes it the correct signal for
// draining the queue.
//
// It is also more accurate than the socket: a message delivered while the
// recipient was offline (fetched later, on the next sync) still gets a
// receipt, which a live-only "sent" event could never account for.
// ──────────────────────────────────────────────────────────────

import { prisma } from '../../config/prisma.js';
import { ApiError } from '../../utils/errors.js';

/** Upper bound per call, so one client can never send an unbounded batch. */
export const MAX_ACK_BATCH = 200;

export interface DeliveryAck {
  messageId: string;
  /** Optional client clock; the server records its own time regardless. */
  at?: string;
}

/**
 * Records that [userId]'s device holds these messages.
 *
 * Idempotent by design: the app retries freely (offline, reconnects) and the
 * unique (messageId, userId) index turns a duplicate into a no-op. Messages
 * the user is not a participant of are silently ignored — an ack can never
 * leak or alter someone else's conversation, and a forged id simply does
 * nothing.
 */
export async function recordDeliveries(
  userId: string,
  acks: DeliveryAck[],
): Promise<{ recorded: number; ignored: number }> {
  if (acks.length === 0) return { recorded: 0, ignored: 0 };
  if (acks.length > MAX_ACK_BATCH) {
    throw ApiError.validation(
      `Envie no máximo ${MAX_ACK_BATCH} confirmações por requisição.`,
    );
  }

  const ids = [...new Set(acks.map((a) => a.messageId).filter(Boolean))];
  if (ids.length === 0) return { recorded: 0, ignored: 0 };

  // Only messages the user may legitimately receive: DM where they are a
  // participant, or a group they are an active member of. Their own messages
  // are excluded (a sender does not "deliver" to themselves).
  const allowed = await prisma.message.findMany({
    where: {
      id: { in: ids },
      senderId: { not: userId },
      OR: [
        { conversation: { OR: [{ userOneId: userId }, { userTwoId: userId }] } },
        { group: { members: { some: { userId, bannedAt: null } } } },
      ],
    },
    select: { id: true },
  });
  const allowedIds = allowed.map((m) => m.id);
  const ignored = ids.length - allowedIds.length;
  if (allowedIds.length === 0) return { recorded: 0, ignored };

  // The unique (messageId, userId) index makes a repeated ack a no-op, so the
  // client can be careless about retrying. `createMany` with skipDuplicates is
  // not supported by the SQLite connector, so each row is upserted inside one
  // transaction — still a single round-trip to the database.
  const written = await prisma.$transaction(
    allowedIds.map((messageId) =>
      prisma.messageDelivery.upsert({
        where: { messageId_userId: { messageId, userId } },
        update: {},
        create: { messageId, userId },
        select: { id: true },
      }),
    ),
  );

  return { recorded: written.length, ignored };
}

/**
 * The message ids (out of [ids]) that this user has NOT confirmed yet.
 * Lets the app ask "what do I still need to ack?" after a long offline
 * period, instead of re-sending every id it has ever seen.
 */
export async function pendingDeliveries(
  userId: string,
  ids: string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const unique = [...new Set(ids)].slice(0, MAX_ACK_BATCH);
  const done = await prisma.messageDelivery.findMany({
    where: { userId, messageId: { in: unique } },
    select: { messageId: true },
  });
  const doneSet = new Set(done.map((d) => d.messageId));
  return unique.filter((id) => !doneSet.has(id));
}
