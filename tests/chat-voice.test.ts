import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { buildTestServer, closeTestServer, createAndLoginUser } from './helpers.js';
import { prisma } from '../src/config/prisma.js';
import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { addSocket, removeSocket } from '../src/modules/push/push.service.js';
import {
  sendVoiceMessage,
  getMessages,
  listConversations,
  VOICE_PREVIEW,
} from '../src/modules/chat/chat.service.js';

let server: FastifyInstance;

beforeAll(async () => {
  server = await buildTestServer();
});
afterAll(async () => {
  await closeTestServer();
});

/** Minimal but structurally valid MP4/M4A container (`....ftyp` + M4A brand). */
function m4aFixture(): Buffer {
  const box = Buffer.alloc(28);
  box.writeUInt32BE(28, 0);
  box.write('ftyp', 4, 'latin1');
  box.write('M4A ', 8, 'latin1');
  box.writeUInt32BE(0, 12);
  box.write('M4A ', 16, 'latin1');
  box.write('mp42', 20, 'latin1');
  box.write('isom', 24, 'latin1');
  return box;
}

const streamOf = (buf: Buffer): Readable => Readable.from([buf]);

async function makeFriends(a: { id: string }, b: { id: string }) {
  await prisma.friendship.create({
    data: {
      userOneId: a.id < b.id ? a.id : b.id,
      userTwoId: a.id < b.id ? b.id : a.id,
    },
  });
}

async function openConversation(a: { accessToken: string }, b: { id: string }) {
  const res = await server.inject({
    method: 'POST',
    url: `/api/conversations/${b.id}`,
    headers: { authorization: `Bearer ${a.accessToken}` },
  });
  return JSON.parse(res.payload).conversation as { id: string };
}

describe('Chat — voice messages', () => {
  it('persists a voice message (type=voice, audioUrl, durationMs) + realtime',
    async () => {
      const a = await createAndLoginUser(server, { nickname: 'vox_a' });
      const b = await createAndLoginUser(server, { nickname: 'vox_b' });
      await makeFriends(a, b);
      const conv = await openConversation(a, b);

      const socket = { send: vi.fn() };
      addSocket(b.id, socket);
      try {
        const msg = await sendVoiceMessage(a.id, conv.id, {
          file: streamOf(m4aFixture()),
          durationMs: 5000,
        });

        expect(msg.type).toBe('voice');
        expect(msg.content).toBe(VOICE_PREVIEW);
        expect(msg.audioUrl).toMatch(/\/static\/audio\//);
        expect(msg.durationMs).toBe(5000);

        // Persisted.
        const stored = await prisma.message.findUnique({ where: { id: msg.id } });
        expect(stored?.type).toBe('voice');
        expect(stored?.audioUrl).toContain('/static/audio/');
        expect(stored?.durationMs).toBe(5000);

        // Realtime frame reaches the peer with audio fields + sender peer.
        expect(socket.send).toHaveBeenCalledOnce();
        const frame = JSON.parse(socket.send.mock.calls[0][0] as string);
        expect(frame.kind).toBe('chat_message');
        expect(frame.data.message.type).toBe('voice');
        expect(frame.data.message.mine).toBe(false);
        expect(frame.data.peer.nickname).toBe('vox_a');
        expect(frame.data.peer.id).toBe(a.id);

        // B's conversation list shows the stable voice preview.
        const [item] = await listConversations(b.id);
        expect(item.lastMessage?.content).toBe(VOICE_PREVIEW);
      } finally {
        removeSocket(b.id, socket);
      }
    });

  it('loads a voice message through getMessages with its type/url/duration', async () => {
    const a = await createAndLoginUser(server, { nickname: 'vox_loada' });
    const b = await createAndLoginUser(server, { nickname: 'vox_loadb' });
    await makeFriends(a, b);
    const conv = await openConversation(a, b);
    const msg = await sendVoiceMessage(a.id, conv.id, {
      file: streamOf(m4aFixture()),
      durationMs: 4123,
    });
    const page = await getMessages(b.id, conv.id, {});
    const loaded = page.messages.find((m) => m.id === msg.id);
    expect(loaded?.type).toBe('voice');
    expect(loaded?.audioUrl).toBe(msg.audioUrl);
    expect(loaded?.durationMs).toBe(4123);
    expect(loaded?.mine).toBe(false);
  });

  it('rejects non-audio bytes (not an ftyp container)', async () => {
    const a = await createAndLoginUser(server, { nickname: 'vox_fake' });
    const b = await createAndLoginUser(server, { nickname: 'vox_fakeb' });
    await makeFriends(a, b);
    const conv = await openConversation(a, b);
    await expect(
      sendVoiceMessage(a.id, conv.id, {
        file: streamOf(Buffer.from('definitely not audio')),
        durationMs: 4000,
      }),
    ).rejects.toMatchObject({ statusCode: 415 });
    expect(await prisma.message.count({ where: { conversationId: conv.id } })).toBe(0);
  });

  it('rejects an out-of-range duration', async () => {
    const a = await createAndLoginUser(server, { nickname: 'vox_dur' });
    const b = await createAndLoginUser(server, { nickname: 'vox_durb' });
    await makeFriends(a, b);
    const conv = await openConversation(a, b);
    await expect(
      sendVoiceMessage(a.id, conv.id, {
        file: streamOf(m4aFixture()),
        durationMs: 100,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await prisma.message.count({ where: { conversationId: conv.id } })).toBe(0);
  });

  it('blocks a non-member (and requires friendship)', async () => {
    const a = await createAndLoginUser(server, { nickname: 'vox_m1' });
    const b = await createAndLoginUser(server, { nickname: 'vox_m2' });
    const eve = await createAndLoginUser(server, { nickname: 'vox_m3' });
    await makeFriends(a, b);
    const conv = await openConversation(a, b);
    // eve is not a friend of a/b and not a member → forbidden.
    await expect(
      sendVoiceMessage(eve.id, conv.id, {
        file: streamOf(m4aFixture()),
        durationMs: 4000,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    const count = await prisma.message.count({ where: { conversationId: conv.id } });
    expect(count).toBe(0);
  });
});