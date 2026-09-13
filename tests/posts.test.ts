import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestServer, closeTestServer, createAndLoginUser } from './helpers.js';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../src/config/prisma.js';

let server: FastifyInstance;

beforeAll(async () => {
  server = await buildTestServer();
});
afterAll(async () => {
  await closeTestServer();
});

describe('Posts — feed + create + delete', () => {
  it('creates a post when authenticated', async () => {
    const u = await createAndLoginUser(server, { nickname: 'poster1' });
    const res = await server.inject({
      method: 'POST',
      url: '/api/posts',
      headers: { authorization: `Bearer ${u.accessToken}` },
      payload: { text: 'Meu primeiro post real!' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.text).toBe('Meu primeiro post real!');
    expect(body.author.nickname).toBe('poster1');
    expect(body.likeCount).toBe(0);
    expect(body.liked).toBe(false);
  });

  it('rejects empty post text', async () => {
    const u = await createAndLoginUser(server, { nickname: 'poster2' });
    const res = await server.inject({
      method: 'POST',
      url: '/api/posts',
      headers: { authorization: `Bearer ${u.accessToken}` },
      payload: { text: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects unauthenticated post creation', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/posts',
      payload: { text: 'anon' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('lists posts in reverse-chronological order with author + counts', async () => {
    const a = await createAndLoginUser(server, { nickname: 'feeda' });
    const b = await createAndLoginUser(server, { nickname: 'feedb' });

    await prisma.post.create({ data: { userId: a.id, text: 'primeiro (mais antigo)' } });
    await new Promise((r) => setTimeout(r, 10));
    await prisma.post.create({ data: { userId: b.id, text: 'segundo (mais novo)' } });

    const res = await server.inject({ method: 'GET', url: '/api/posts?limit=10' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.posts).toHaveLength(2);
    expect(body.posts[0].text).toBe('segundo (mais novo)');
    expect(body.nextCursor).toBeNull();
  });

  it('paginates with a cursor', async () => {
    const u = await createAndLoginUser(server, { nickname: 'pager' });
    for (let i = 0; i < 5; i++) {
      await prisma.post.create({ data: { userId: u.id, text: `post ${i}` } });
      await new Promise((r) => setTimeout(r, 5));
    }
    const first = await server.inject({ method: 'GET', url: '/api/posts?limit=2' });
    const firstBody = JSON.parse(first.payload);
    expect(firstBody.posts).toHaveLength(2);
    expect(firstBody.nextCursor).not.toBeNull();

    const second = await server.inject({
      method: 'GET',
      url: `/api/posts?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    });
    const secondBody = JSON.parse(second.payload);
    expect(secondBody.posts).toHaveLength(2);
  });

  it('lets the owner delete their own post', async () => {
    const u = await createAndLoginUser(server, { nickname: 'deleter' });
    const created = await server.inject({
      method: 'POST',
      url: '/api/posts',
      headers: { authorization: `Bearer ${u.accessToken}` },
      payload: { text: 'to be deleted' },
    });
    const postId = JSON.parse(created.payload).id;
    const res = await server.inject({
      method: 'DELETE',
      url: `/api/posts/${postId}`,
      headers: { authorization: `Bearer ${u.accessToken}` },
    });
    expect(res.statusCode).toBe(204);
  });

  it('cascades likes and comments when a post is deleted', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'cascadeowner' });
    const fan = await createAndLoginUser(server, { nickname: 'cascadefan' });
    const created = await server.inject({
      method: 'POST',
      url: '/api/posts',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { text: 'post with engagement' },
    });
    const postId = JSON.parse(created.payload).id as string;
    await server.inject({
      method: 'POST',
      url: `/api/posts/${postId}/like`,
      headers: { authorization: `Bearer ${fan.accessToken}` },
    });
    await server.inject({
      method: 'POST',
      url: `/api/posts/${postId}/comments`,
      headers: { authorization: `Bearer ${fan.accessToken}` },
      payload: { text: 'nice' },
    });

    const res = await server.inject({
      method: 'DELETE',
      url: `/api/posts/${postId}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(res.statusCode).toBe(204);

    const { prisma } = await import('../src/config/prisma.js');
    expect(await prisma.like.count({ where: { postId } })).toBe(0);
    expect(await prisma.comment.count({ where: { postId } })).toBe(0);
    expect(await prisma.post.findUnique({ where: { id: postId } })).toBeNull();
  });

  it('returns 404 when deleting a nonexistent post', async () => {
    const u = await createAndLoginUser(server, { nickname: 'ghostdeleter' });
    const res = await server.inject({
      method: 'DELETE',
      url: '/api/posts/does-not-exist',
      headers: { authorization: `Bearer ${u.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects unauthenticated deletion', async () => {
    const res = await server.inject({ method: 'DELETE', url: '/api/posts/whatever' });
    expect(res.statusCode).toBe(401);
  });

  it('forbids deleting another user post', async () => {
    const owner = await createAndLoginUser(server, { nickname: 'ownera' });
    const other = await createAndLoginUser(server, { nickname: 'othera' });
    const created = await server.inject({
      method: 'POST',
      url: '/api/posts',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { text: 'not yours' },
    });
    const postId = JSON.parse(created.payload).id;
    const res = await server.inject({
      method: 'DELETE',
      url: `/api/posts/${postId}`,
      headers: { authorization: `Bearer ${other.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('Posts — vídeos', () => {
  // Minimal valid MP4/ISOBMFF (ftyp box with mp42 brand) that passes the
  // server's real-bytes validation without requiring an actual encoded video.
  function mp4Fixture(): Buffer {
    const box = Buffer.alloc(32);
    box.writeUInt32BE(32, 0);
    box.write('ftyp', 4, 'latin1');
    box.write('mp42', 8, 'latin1');
    box.writeUInt32BE(0, 12);
    box.writeUInt32BE(0, 16);
    box.writeUInt32BE(0, 20);
    box.writeUInt32BE(0, 24);
    box.writeUInt32BE(0, 28);
    return box;
  }

  function multipartBody(bytes: Buffer, filename: string): Buffer {
    const boundary = '----matrix-video-test-boundary-x7';
    const preamble = Buffer.from(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="file"; ' +
        `filename="${filename}"\r\n` +
        'Content-Type: video/mp4\r\n\r\n',
      'utf8',
    );
    const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    return Buffer.concat([preamble, bytes, epilogue]);
  }

  it('uploads a video and creates a post with videoUrl (feed exposes it)', async () => {
    const u = await createAndLoginUser(server, { nickname: 'vid_poster' });

    // Upload a valid MP4.
    const upRes = await server.inject({
      method: 'POST',
      url: '/api/uploads/video',
      headers: {
        authorization: `Bearer ${u.accessToken}`,
        'content-type': 'multipart/form-data; boundary=----matrix-video-test-boundary-x7',
      },
      payload: multipartBody(mp4Fixture(), 'clip.mp4'),
    });
    expect(upRes.statusCode).toBe(201);
    const uploaded = JSON.parse(upRes.payload);
    expect(uploaded.url).toMatch(/\/static\/video\/.+\.mp4$/);

    // Create a post referencing the uploaded video.
    const postRes = await server.inject({
      method: 'POST',
      url: '/api/posts',
      headers: { authorization: `Bearer ${u.accessToken}` },
      payload: { text: 'meu vídeo', videoUrl: uploaded.url },
    });
    expect(postRes.statusCode).toBe(201);
    const post = JSON.parse(postRes.payload);
    expect(post.videoUrl).toBe(uploaded.url);
    expect(post.imageUrl).toBeNull();

    // The feed exposes videoUrl.
    const feed = await server.inject({
      method: 'GET',
      url: '/api/posts',
      headers: { authorization: `Bearer ${u.accessToken}` },
    });
    const body = JSON.parse(feed.payload);
    expect(body.posts.some((p: { id: string; videoUrl: string | null }) =>
        p.id === post.id && p.videoUrl === uploaded.url)).toBe(true);
  });

  it('rejects fake videos (wrong magic) even with .mp4 name', async () => {
    const u = await createAndLoginUser(server, { nickname: 'vid_fake' });
    const res = await server.inject({
      method: 'POST',
      url: '/api/uploads/video',
      headers: {
        authorization: `Bearer ${u.accessToken}`,
        'content-type': 'multipart/form-data; boundary=----matrix-video-test-boundary-x7',
      },
      payload: multipartBody(Buffer.from('não é um mp4 de verdade...', 'utf8'), 'fake.mp4'),
    });
    expect(res.statusCode).toBe(415);
  });

  it('rejects a post with BOTH imageUrl and videoUrl', async () => {
    const u = await createAndLoginUser(server, { nickname: 'vid_both' });
    const res = await server.inject({
      method: 'POST',
      url: '/api/posts',
      headers: { authorization: `Bearer ${u.accessToken}` },
      payload: {
        text: 'dupla',
        imageUrl: '/static/img.png',
        videoUrl: '/static/video/x.mp4',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an invalid videoUrl', async () => {
    const u = await createAndLoginUser(server, { nickname: 'vid_badurl' });
    const res = await server.inject({
      method: 'POST',
      url: '/api/posts',
      headers: { authorization: `Bearer ${u.accessToken}` },
      payload: { text: 'x', videoUrl: 'javascript:alert(1)' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('deleting a video post cleans its stored file reference', async () => {
    const u = await createAndLoginUser(server, { nickname: 'vid_del' });
    const upRes = await server.inject({
      method: 'POST',
      url: '/api/uploads/video',
      headers: {
        authorization: `Bearer ${u.accessToken}`,
        'content-type': 'multipart/form-data; boundary=----matrix-video-test-boundary-x7',
      },
      payload: multipartBody(mp4Fixture(), 'del.mp4'),
    });
    const url = JSON.parse(upRes.payload).url as string;

    const postRes = await server.inject({
      method: 'POST',
      url: '/api/posts',
      headers: { authorization: `Bearer ${u.accessToken}` },
      payload: { text: 'apagar', videoUrl: url },
    });
    const post = JSON.parse(postRes.payload);

    const del = await server.inject({
      method: 'DELETE',
      url: `/api/posts/${post.id}`,
      headers: { authorization: `Bearer ${u.accessToken}` },
    });
    expect(del.statusCode).toBe(204);

    // The stored row is gone.
    const row = await prisma.post.findUnique({ where: { id: post.id } });
    expect(row).toBeNull();
  });
});
