import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestServer, closeTestServer, createAndLoginUser } from './helpers.js';
import { prisma } from '../src/config/prisma.js';
import type { FastifyInstance } from 'fastify';

let server: FastifyInstance;

beforeAll(async () => {
  server = await buildTestServer();
});
afterAll(async () => {
  await closeTestServer();
});

describe('Comments', () => {
  it('creates a comment on a post', async () => {
    const author = await createAndLoginUser(server, { nickname: 'cmauthor' });
    const commenter = await createAndLoginUser(server, { nickname: 'commenter' });
    const post = await prisma.post.create({ data: { userId: author.id, text: 'hello' } });

    const res = await server.inject({
      method: 'POST',
      url: `/api/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${commenter.accessToken}` },
      payload: { text: 'Primeiro comentário!' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.text).toBe('Primeiro comentário!');
    expect(body.author.nickname).toBe('commenter');
  });

  it('lists comments for a post', async () => {
    const author = await createAndLoginUser(server, { nickname: 'cmauthor2' });
    const commenter = await createAndLoginUser(server, { nickname: 'commenter2' });
    const post = await prisma.post.create({ data: { userId: author.id, text: 'hello' } });

    await server.inject({ method: 'POST', url: `/api/posts/${post.id}/comments`, headers: { authorization: `Bearer ${commenter.accessToken}` }, payload: { text: 'c1' } });
    await server.inject({ method: 'POST', url: `/api/posts/${post.id}/comments`, headers: { authorization: `Bearer ${commenter.accessToken}` }, payload: { text: 'c2' } });

    const res = await server.inject({ method: 'GET', url: `/api/posts/${post.id}/comments` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.comments).toHaveLength(2);
    expect(body.comments[0].text).toBe('c2'); // newest first
  });

  it('rejects empty comment', async () => {
    const author = await createAndLoginUser(server, { nickname: 'cmauthor3' });
    const post = await prisma.post.create({ data: { userId: author.id, text: 'hello' } });
    const res = await server.inject({
      method: 'POST',
      url: `/api/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${author.accessToken}` },
      payload: { text: '   ' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('lets owner delete their comment', async () => {
    const author = await createAndLoginUser(server, { nickname: 'cmauthor4' });
    const post = await prisma.post.create({ data: { userId: author.id, text: 'hello' } });
    const created = await server.inject({
      method: 'POST',
      url: `/api/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${author.accessToken}` },
      payload: { text: 'mine' },
    });
    const commentId = JSON.parse(created.payload).id;
    const res = await server.inject({
      method: 'DELETE',
      url: `/api/comments/${commentId}`,
      headers: { authorization: `Bearer ${author.accessToken}` },
    });
    expect(res.statusCode).toBe(204);
  });

  it('forbids deleting another user comment', async () => {
    const author = await createAndLoginUser(server, { nickname: 'cmauthor5' });
    const other = await createAndLoginUser(server, { nickname: 'othercomment' });
    const post = await prisma.post.create({ data: { userId: author.id, text: 'hello' } });
    const created = await server.inject({
      method: 'POST',
      url: `/api/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${author.accessToken}` },
      payload: { text: 'mine' },
    });
    const commentId = JSON.parse(created.payload).id;
    const res = await server.inject({
      method: 'DELETE',
      url: `/api/comments/${commentId}`,
      headers: { authorization: `Bearer ${other.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 when commenting on a missing post', async () => {
    const commenter = await createAndLoginUser(server, { nickname: 'commenter9' });
    const res = await server.inject({
      method: 'POST',
      url: '/api/posts/missing/comments',
      headers: { authorization: `Bearer ${commenter.accessToken}` },
      payload: { text: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('creates a reply under a top-level comment with parentCommentId set', async () => {
    const author = await createAndLoginUser(server, { nickname: 'rpauthor' });
    const commenter = await createAndLoginUser(server, { nickname: 'rpcommenter' });
    const post = await prisma.post.create({ data: { userId: author.id, text: 'post' } });
    const created = await server.inject({
      method: 'POST',
      url: `/api/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${commenter.accessToken}` },
      payload: { text: 'original' },
    });
    const parentId = JSON.parse(created.payload).id;

    const res = await server.inject({
      method: 'POST',
      url: `/api/comments/${parentId}/replies`,
      headers: { authorization: `Bearer ${commenter.accessToken}` },
      payload: { text: 'resposta' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.text).toBe('resposta');
    expect(body.parentCommentId).toBe(parentId);
    expect(body.author.nickname).toBe('rpcommenter');
  });

  it('lists replies of a top-level comment (oldest first)', async () => {
    const author = await createAndLoginUser(server, { nickname: 'rpauthor2' });
    const user = await createAndLoginUser(server, { nickname: 'rpuser2' });
    const post = await prisma.post.create({ data: { userId: author.id, text: 'post' } });
    const created = await server.inject({
      method: 'POST',
      url: `/api/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { text: 'orig' },
    });
    const parentId = JSON.parse(created.payload).id;
    for (const t of ['r1', 'r2', 'r3']) {
      await server.inject({
        method: 'POST',
        url: `/api/comments/${parentId}/replies`,
        headers: { authorization: `Bearer ${user.accessToken}` },
        payload: { text: t },
      });
    }

    const res = await server.inject({
      method: 'GET',
      url: `/api/comments/${parentId}/replies`,
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.replies).toHaveLength(3);
    expect(body.replies.map((r: { text: string }) => r.text)).toEqual(['r1', 'r2', 'r3']);
    // Replies never appear in the top-level comment list.
    const top = await server.inject({
      method: 'GET',
      url: `/api/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    const topBody = JSON.parse(top.payload);
    expect(topBody.comments).toHaveLength(1);
    expect(topBody.comments[0].id).toBe(parentId);
  });

  it('re-parents a reply-to-a-reply onto the top-level comment', async () => {
    const author = await createAndLoginUser(server, { nickname: 'rpauthor3' });
    const user = await createAndLoginUser(server, { nickname: 'rpuser3' });
    const post = await prisma.post.create({ data: { userId: author.id, text: 'post' } });
    const created = await server.inject({
      method: 'POST',
      url: `/api/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { text: 'orig' },
    });
    const rootId = JSON.parse(created.payload).id;
    const replyRes = await server.inject({
      method: 'POST',
      url: `/api/comments/${rootId}/replies`,
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { text: 'nested' },
    });
    const replyId = JSON.parse(replyRes.payload).id;

    const deep = await server.inject({
      method: 'POST',
      url: `/api/comments/${replyId}/replies`,
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { text: 'deep' },
    });
    expect(deep.statusCode).toBe(201);
    expect(JSON.parse(deep.payload).parentCommentId).toBe(rootId);
  });

  it('toggles like on a comment (server is the source of truth)', async () => {
    const author = await createAndLoginUser(server, { nickname: 'cltauthor' });
    const commenter = await createAndLoginUser(server, { nickname: 'cltcommenter' });
    const liker = await createAndLoginUser(server, { nickname: 'cltliker' });
    const post = await prisma.post.create({ data: { userId: author.id, text: 'post' } });
    const created = await server.inject({
      method: 'POST',
      url: `/api/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${commenter.accessToken}` },
      payload: { text: 'curtável' },
    });
    const commentId = JSON.parse(created.payload).id;

    const like = await server.inject({
      method: 'POST',
      url: `/api/comments/${commentId}/like`,
      headers: { authorization: `Bearer ${liker.accessToken}` },
    });
    expect(like.statusCode).toBe(200);
    expect(JSON.parse(like.payload)).toEqual({ liked: true, likeCount: 1 });

    // The liker sees liked=true in the comment payload; the author sees false.
    const asLiker = await server.inject({
      method: 'GET',
      url: `/api/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${liker.accessToken}` },
    });
    expect(JSON.parse(asLiker.payload).comments[0].liked).toBe(true);
    expect(JSON.parse(asLiker.payload).comments[0].likeCount).toBe(1);
    const asAuthor = await server.inject({
      method: 'GET',
      url: `/api/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${author.accessToken}` },
    });
    expect(JSON.parse(asAuthor.payload).comments[0].liked).toBe(false);

    // Unlike flips it back.
    const unlike = await server.inject({
      method: 'DELETE',
      url: `/api/comments/${commentId}/like`,
      headers: { authorization: `Bearer ${liker.accessToken}` },
    });
    expect(JSON.parse(unlike.payload)).toEqual({ liked: false, likeCount: 0 });
  });

  it('keeps comment and reply likes independent', async () => {
    const author = await createAndLoginUser(server, { nickname: 'indauthor' });
    const user = await createAndLoginUser(server, { nickname: 'induser' });
    const post = await prisma.post.create({ data: { userId: author.id, text: 'post' } });
    const created = await server.inject({
      method: 'POST',
      url: `/api/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { text: 'orig' },
    });
    const commentId = JSON.parse(created.payload).id;
    const replyRes = await server.inject({
      method: 'POST',
      url: `/api/comments/${commentId}/replies`,
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { text: 'resp' },
    });
    const replyId = JSON.parse(replyRes.payload).id;

    await server.inject({
      method: 'POST',
      url: `/api/comments/${commentId}/like`,
      headers: { authorization: `Bearer ${author.accessToken}` },
    });
    await server.inject({
      method: 'POST',
      url: `/api/comments/${replyId}/like`,
      headers: { authorization: `Bearer ${author.accessToken}` },
    });

    const replies = await server.inject({
      method: 'GET',
      url: `/api/comments/${commentId}/replies`,
      headers: { authorization: `Bearer ${author.accessToken}` },
    });
    expect(JSON.parse(replies.payload).replies[0].liked).toBe(true);
    expect(JSON.parse(replies.payload).replies[0].likeCount).toBe(1);
    const top = await server.inject({
      method: 'GET',
      url: `/api/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${author.accessToken}` },
    });
    expect(JSON.parse(top.payload).comments[0].liked).toBe(true);
    expect(JSON.parse(top.payload).comments[0].likeCount).toBe(1);
  });

  it('returns 404 when replying to a missing comment', async () => {
    const user = await createAndLoginUser(server, { nickname: 'rpmissing' });
    const res = await server.inject({
      method: 'POST',
      url: '/api/comments/missing/replies',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { text: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when liking a missing comment', async () => {
    const user = await createAndLoginUser(server, { nickname: 'cltmissing' });
    const res = await server.inject({
      method: 'POST',
      url: '/api/comments/missing/like',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('post AUTHOR can delete another user\'s comment (soft delete hides it)', async () => {
    const author = await createAndLoginUser(server, { nickname: 'postauthor' });
    const commenter = await createAndLoginUser(server, { nickname: 'cmtuser' });
    const post = await prisma.post.create({ data: { userId: author.id, text: 'post' } });
    const created = await server.inject({
      method: 'POST',
      url: `/api/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${commenter.accessToken}` },
      payload: { text: 'comentário do Leo' },
    });
    const commentId = JSON.parse(created.payload).id;

    // The post author (M06) removes Leo's comment.
    const del = await server.inject({
      method: 'DELETE',
      url: `/api/comments/${commentId}`,
      headers: { authorization: `Bearer ${author.accessToken}` },
    });
    expect(del.statusCode).toBe(204);

    // Deleted comment no longer lists.
    const list = await server.inject({
      method: 'GET',
      url: `/api/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${commenter.accessToken}` },
    });
    expect(JSON.parse(list.payload).comments).toHaveLength(0);
    // Row kept (soft delete) for audit.
    const kept = await prisma.comment.findUnique({ where: { id: commentId } });
    expect(kept).not.toBeNull();
    expect(kept?.deletedAt).not.toBeNull();
  });

  it('commenter can delete their OWN comment on someone else\'s post', async () => {
    const author = await createAndLoginUser(server, { nickname: 'ownauthor' });
    const commenter = await createAndLoginUser(server, { nickname: 'ownowner' });
    const post = await prisma.post.create({ data: { userId: author.id, text: 'post' } });
    const created = await server.inject({
      method: 'POST',
      url: `/api/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${commenter.accessToken}` },
      payload: { text: 'Legal!' },
    });
    const commentId = JSON.parse(created.payload).id;

    const del = await server.inject({
      method: 'DELETE',
      url: `/api/comments/${commentId}`,
      headers: { authorization: `Bearer ${commenter.accessToken}` },
    });
    expect(del.statusCode).toBe(204);
    const list = await server.inject({
      method: 'GET',
      url: `/api/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${commenter.accessToken}` },
    });
    expect(JSON.parse(list.payload).comments).toHaveLength(0);
  });

  it('a THIRD-PARTY user (neither author nor commenter of another\'s post) is FORBIDDEN', async () => {
    const author = await createAndLoginUser(server, { nickname: 'thirdauthor' });
    const commenter = await createAndLoginUser(server, { nickname: 'thirdcmt' });
    const stranger = await createAndLoginUser(server, { nickname: 'stranger9' });
    const post = await prisma.post.create({ data: { userId: author.id, text: 'post' } });
    const created = await server.inject({
      method: 'POST',
      url: `/api/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${commenter.accessToken}` },
      payload: { text: 'de terceiro' },
    });
    const commentId = JSON.parse(created.payload).id;

    const del = await server.inject({
      method: 'DELETE',
      url: `/api/comments/${commentId}`,
      headers: { authorization: `Bearer ${stranger.accessToken}` },
    });
    expect(del.statusCode).toBe(403);

    // The comment is still there.
    const list = await server.inject({
      method: 'GET',
      url: `/api/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${stranger.accessToken}` },
    });
    expect(JSON.parse(list.payload).comments).toHaveLength(1);

    // And a stranger can't delete even a reply.
    const rep = await server.inject({
      method: 'POST',
      url: `/api/comments/${commentId}/replies`,
      headers: { authorization: `Bearer ${commenter.accessToken}` },
      payload: { text: 'reply' },
    });
    const replyId = JSON.parse(rep.payload).id;
    const delReply = await server.inject({
      method: 'DELETE',
      url: `/api/comments/${replyId}`,
      headers: { authorization: `Bearer ${stranger.accessToken}` },
    });
    expect(delReply.statusCode).toBe(403);
  });

  it('deleting a TOP-LEVEL comment also hides its replies', async () => {
    const author = await createAndLoginUser(server, { nickname: 'tlauthor' });
    const user = await createAndLoginUser(server, { nickname: 'tluser' });
    const post = await prisma.post.create({ data: { userId: author.id, text: 'post' } });
    const created = await server.inject({
      method: 'POST',
      url: `/api/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { text: 'orig' },
    });
    const parentId = JSON.parse(created.payload).id;
    const rep = await server.inject({
      method: 'POST',
      url: `/api/comments/${parentId}/replies`,
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { text: 'filho' },
    });
    const replyId = JSON.parse(rep.payload).id;

    // Commenter deletes their top-level comment → reply disappears too.
    const del = await server.inject({
      method: 'DELETE',
      url: `/api/comments/${parentId}`,
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(del.statusCode).toBe(204);

    const top = await server.inject({
      method: 'GET',
      url: `/api/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(JSON.parse(top.payload).comments).toHaveLength(0);
    const replies = await server.inject({
      method: 'GET',
      url: `/api/comments/${parentId}/replies`,
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(JSON.parse(replies.payload).replies).toHaveLength(0);
    expect((await prisma.comment.findUnique({ where: { id: replyId } }))?.deletedAt).not.toBeNull();
  });

  it('unauthenticated user cannot delete a comment', async () => {
    const author = await createAndLoginUser(server, { nickname: 'uaauthor' });
    const user = await createAndLoginUser(server, { nickname: 'uauser' });
    const post = await prisma.post.create({ data: { userId: author.id, text: 'post' } });
    const created = await server.inject({
      method: 'POST',
      url: `/api/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { text: 'a comentar' },
    });
    const commentId = JSON.parse(created.payload).id;
    const del = await server.inject({
      method: 'DELETE',
      url: `/api/comments/${commentId}`,
    });
    expect(del.statusCode).toBe(401);
  });

  it('comment ORDER grants no extra permission: first commenter cannot delete later comments', async () => {
    const user1 = await createAndLoginUser(server, { nickname: 'ord_owner' });
    const user2 = await createAndLoginUser(server, { nickname: 'ord_first' });
    const user3 = await createAndLoginUser(server, { nickname: 'ord_second' });

    // User1 creates the post.

    const post = await prisma.post.create({ data: { userId: user1.id, text: 'post do User1' } });

    // User2 comments FIRST;User3 comments AFTER.

    const first = await server.inject({
      method: 'POST',
      url: `/api/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${user2.accessToken}` },
      payload: { text: 'primeiro comentário (User2)' },
    });
    const firstId = JSON.parse(first.payload).id;
    const second = await server.inject({
      method: 'POST',
      url: `/api/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${user3.accessToken}` },
      payload: { text: 'segundo comentário (User3)' },
    });
    const secondId = JSON.parse(second.payload).id;

    // User2 (first commenter, NOT the post author) tries to delete User3's
    // comment → MUST BE DENIED despite having commented first..
    const denied = await server.inject({
      method: 'DELETE',
      url: `/api/comments/${secondId}`,
      headers: { authorization: `Bearer ${user2.accessToken}` },
    });
    expect(denied.statusCode).toBe(403);

    // The comment survives the denied attempt..
    const listAfterDenial = await server.inject({
      method: 'GET',
      url: `/api/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${user2.accessToken}` },
    });
    expect(JSON.parse(listAfterDenial.payload).comments).toHaveLength(2);

    // User1 (post author) CAN delete User3's comment..
    const byOwner = await server.inject({
      method: 'DELETE',
      url: `/api/comments/${secondId}`,
      headers: { authorization: `Bearer ${user1.accessToken}` },
    });
    expect(byOwner.statusCode).toBe(204);
    const listAfterOwner = await server.inject({
      method: 'GET',
      url: `/api/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${user2.accessToken}` },
    });
    expect(JSON.parse(listAfterOwner.payload).comments).toHaveLength(1);

    // User2 can still delete their OWN comment..
    const own = await server.inject({
      method: 'DELETE',
      url: `/api/comments/${firstId}`,
      headers: { authorization: `Bearer ${user2.accessToken}` },
    });
    expect(own.statusCode).toBe(204);
    const listAfterOwn = await server.inject({
      method: 'GET',
      url: `/api/posts/${post.id}/comments`,
      headers: { authorization: `Bearer ${user2.accessToken}` },
    });
    expect(JSON.parse(listAfterOwn.payload).comments).toHaveLength(0);
  });
});
