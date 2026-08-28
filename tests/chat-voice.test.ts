import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { buildTestServer, closeTestServer, createAndLoginUser } from './helpers.js';
import { prisma } from '../src/config/prisma.js';
import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
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

/** Builds a raw multipart/form-data body with a single `file` field — the
 * exact shape dio sends when a Flutter app uploads voice audio.
 */
function multipartBody(fileBytes: Buffer, filename: string): Buffer {
  const boundary = '----matrix-test-boundary-7c2e';
  const preamble = Buffer.from(
    `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="file"; ' +
      `filename="${filename}"\r\n` +
      'Content-Type: audio/mp4\r\n\r\n',
    'utf8',
  );
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return Buffer.concat([preamble, fileBytes, epilogue]);
}

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

  it('end-to-end: multipart HTTP upload - magic-bytes validation - disk '
    + 'storage - static GET - message row - realtime', async () => {
    const a = await createAndLoginUser(server, { nickname: 'vox_e2e' });
    const b = await createAndLoginUser(server, { nickname: 'vox_e2eb' });
    await makeFriends(a, b);
    const conv = await openConversation(a, b);

    const audio = m4aFixture();
    const boundary = '----matrix-test-boundary-7c2e';
    const socket = { send: vi.fn() };
    addSocket(b.id, socket);
    try {
      // The exact request shape the Flutter app sends: multipart `file`
      // field + durationMs query (dio sets the content-type itself).
      const res = await server.inject({
        method: 'POST',
        url: `/api/conversations/${conv.id}/voice?durationMs=2500`,
        headers: {
          authorization: `Bearer ${a.accessToken}`,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: multipartBody(audio, 'voice.m4a'),
      });
      expect(res.statusCode).toBe(201);
      const msg = JSON.parse(res.payload as string).message as {
        type: string;
        durationMs: number;
        audioUrl: string;
        id: string;
      };
      expect(msg.type).toBe('voice');
      expect(msg.durationMs).toBe(2500);
      expect(msg.audioUrl).toMatch(/^https?:\/\/.+\/static\/audio\/.+\.m4a$/);

      // The audio really landed on disk under uploads/audio/.
      const filePath = path.join(
        process.cwd(), 'uploads', 'audio', path.basename(msg.audioUrl),
      );
      const onDisk = await readFile(filePath);
      expect(onDisk.length).toBeGreaterThanOrEqual(audio.length);
      expect(onDisk.subarray(0, audio.length).equals(audio)).toBe(true);

      // The static route serves the exact bytes back (public playback URL).
      const served = await server.inject({ method: 'GET', url: msg.audioUrl });
      expect(served.statusCode).toBe(200);
      expect(Buffer.compare(served.rawPayload, onDisk)).toBe(0);

      // The message row exists and carries the audio reference.
      const stored = await prisma.message.findUnique({ where: { id: msg.id } });
      expect(stored?.type).toBe('voice');
      expect(stored?.audioUrl).toBe(msg.audioUrl);
      expect(stored?.durationMs).toBe(2500);

      // The peer received the realtime frame with the voice payload.

      expect(socket.send).toHaveBeenCalledOnce();
      const frame = JSON.parse(socket.send.mock.calls[0][0] as string);
      expect(frame.kind).toBe('chat_message');
      expect(frame.data.message.type).toBe('voice');
      expect(frame.data.message.mine).toBe(false);
    } finally {
      removeSocket(b.id, socket);
    }
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
