import { prisma } from '../../config/prisma.js';
import { ApiError } from '../../utils/errors.js';

// ── Matrix Calls (contracts only) ─────────────────────────────
// This phase defines the data model and lifecycle for call rooms and
// participants. The actual media transport (WebRTC/SFU) is intentionally
// left for a future phase — only the room/participant contracts exist here.

export interface CallRoomDto {
  id: string;
  ownerId: string;
  title: string;
  status: string;
  createdAt: string;
  endedAt: string | null;
}

export async function createRoom(userId: string, title: string): Promise<CallRoomDto> {
  const room = await prisma.callRoom.create({ data: { ownerId: userId, title } });
  await prisma.callParticipant.create({
    data: { roomId: room.id, userId, status: 'joined' },
  });
  return toDto(room);
}

export async function listRooms(): Promise<CallRoomDto[]> {
  const rooms = await prisma.callRoom.findMany({
    where: { status: 'active', endedAt: null },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return rooms.map(toDto);
}

export async function joinRoom(userId: string, roomId: string): Promise<void> {
  const room = await prisma.callRoom.findUnique({ where: { id: roomId } });
  if (!room || room.status !== 'active' || room.endedAt) {
    throw ApiError.notFound('Sala não encontrada ou encerrada.');
  }
  await prisma.callParticipant.upsert({
    where: { roomId_userId: { roomId, userId } },
    update: { status: 'joined', leftAt: null },
    create: { roomId, userId, status: 'joined' },
  });
}

export async function leaveRoom(userId: string, roomId: string): Promise<void> {
  await prisma.callParticipant.updateMany({
    where: { roomId, userId },
    data: { status: 'left', leftAt: new Date() },
  });
}

export async function endRoom(userId: string, roomId: string): Promise<void> {
  const room = await prisma.callRoom.findUnique({ where: { id: roomId } });
  if (!room) throw ApiError.notFound('Sala não encontrada.');
  if (room.ownerId !== userId) throw ApiError.forbidden('Apenas o dono pode encerrar a sala.');
  await prisma.callRoom.update({
    where: { id: roomId },
    data: { status: 'ended', endedAt: new Date() },
  });
  await prisma.callParticipant.updateMany({
    where: { roomId },
    data: { status: 'left', leftAt: new Date() },
  });
}

export async function listParticipants(roomId: string) {
  return prisma.callParticipant.findMany({
    where: { roomId, status: 'joined' },
  });
}

function toDto(room: { id: string; ownerId: string; title: string; status: string; createdAt: Date; endedAt: Date | null }): CallRoomDto {
  return {
    id: room.id,
    ownerId: room.ownerId,
    title: room.title,
    status: room.status,
    createdAt: room.createdAt.toISOString(),
    endedAt: room.endedAt?.toISOString() ?? null,
  };
}
