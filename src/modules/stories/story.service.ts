import { prisma } from '../../config/prisma.js';
import { ApiError } from '../../utils/errors.js';
import { deleteLocalFileByUrl } from '../uploads/upload.service.js';
import { validateVideoDurationMs } from '../../utils/storage.js';
import { getOrCreateConversation, sendMessage } from '../chat/chat.service.js';
import {
  AUTHOR_SELECT,
  nicknameCosmetics,
  type NicknameCosmeticsPayload,
} from '../../utils/dto.js';

// ── Stories ──────────────────────────────────────────────────
// Ephemeral media that expires 24h after publication. Built ENTIRELY on the
// existing MATRIX stack: same auth, same users/avatars (AUTHOR_SELECT +
// the same author fragment the feed embeds, so nickname/avatar/cosmetics
// render identically), same upload/storage (mediaUrl/thumbnailUrl are the
// very references a Post uses). No parallel media or user system.

/** Server-side lifetime of a story. */
export const STORY_TTL_MS = 24 * 60 * 60 * 1000;

/** Max length of a TEXT story. */
export const STORY_TEXT_LIMIT = 300;

/** Max length of a story REPLY (a real chat message). */
export const STORY_REPLY_LIMIT = 500;

/** Author fragment — EXACTLY the shape the feed embeds for a post author. */
export type StoryAuthor = {
  id: string;
  nickname: string;
  avatarUrl: string | null;
} & NicknameCosmeticsPayload;

type StoryRow = {
  id: string;
  userId: string;
  type: string;
  mediaUrl: string;
  mediaType: string;
  text: string;
  thumbnailUrl: string | null;
  caption: string;
  expiresAt: Date;
  createdAt: Date;
  user: { id: string; nickname: string; avatarUrl: string | null } & Parameters<
    typeof nicknameCosmetics
  >[0];
};

export interface StoryItem {
  id: string;
  author: StoryAuthor;
  /** 'image' | 'video' | 'text' — ONE shape for every story kind. */
  type: 'image' | 'video' | 'text';
  /** Media reference (IMAGE/VIDEO only; null for a text story). */
  mediaUrl: string | null;
  mediaType: 'image' | 'video';
  /** Text content (TEXT stories only; empty for media stories). */
  text: string;
  thumbnailUrl: string | null;
  caption: string;
  expiresAt: string;
  createdAt: string;
  /** Whether the REQUESTING user already opened this story. */
  viewed: boolean;
  /** Whether the requesting user is the author (drives the delete action). */
  mine: boolean;
  /** Whether the REQUESTING user liked this story (same as the feed). */
  liked: boolean;
  likeCount: number;
}

function storyKind(story: { type: string; mediaType: string }): 'image' | 'video' | 'text' {
  if (story.type === 'text') return 'text';
  if (story.type === 'video') return 'video';
  return story.mediaType === 'video' ? 'video' : 'image';
}

function toStoryItem(
  story: StoryRow,
  viewerId: string,
  viewed: boolean,
  liked = false,
  likeCount = 0,
): StoryItem {
  const kind = storyKind(story);
  return {
    id: story.id,
    author: {
      id: story.user.id,
      nickname: story.user.nickname,
      avatarUrl: story.user.avatarUrl,
      ...nicknameCosmetics(story.user),
    },
    type: kind,
    // An empty mediaUrl means "text story" — the app receives null and
    // renders the centered text instead of trying to load media.
    mediaUrl: story.mediaUrl ? story.mediaUrl : null,
    mediaType: kind === 'video' ? 'video' : 'image',
    text: story.text ?? '',
    thumbnailUrl: story.thumbnailUrl ?? null,
    caption: story.caption ?? '',
    expiresAt: story.expiresAt.toISOString(),
    createdAt: story.createdAt.toISOString(),
    viewed,
    mine: story.userId === viewerId,
    liked,
    likeCount,
  };
}

export interface CreateStoryInput {
  /** 'image' | 'video' | 'text'. */
  type?: 'image' | 'video' | 'text';
  /** Required for image/video; ignored (empty) for text. */
  mediaUrl?: string | null;
  mediaType?: 'image' | 'video';
  /** Required for text stories. */
  text?: string | null;
  /** Real media duration (video only) — validated against the 2-minute cap. */
  durationMs?: number | null;
  thumbnailUrl?: string | null;
  caption?: string | null;
}

/** Creates a story for [userId]. Expiry is computed HERE (never the client). */
export async function createStory(
  userId: string,
  input: CreateStoryInput,
): Promise<StoryItem> {
  const type = input.type ?? (input.mediaType === 'video' ? 'video' : 'image');
  if (type === 'text') {
    const text = (input.text ?? '').trim();
    if (text.length === 0) {
      throw ApiError.validation('Escreva algo para publicar o Story.');
    }
    if (text.length > STORY_TEXT_LIMIT) {
      throw ApiError.validation(
        `O Story deve ter no máximo ${STORY_TEXT_LIMIT} caracteres.`,
      );
    }
    const story = await prisma.story.create({
      data: {
        userId,
        type: 'text',
        mediaUrl: '',
        mediaType: 'image',
        text: text,
        expiresAt: new Date(Date.now() + STORY_TTL_MS),
      },
      include: { user: { select: AUTHOR_SELECT } },
    });
    return toStoryItem(story as unknown as StoryRow, userId, false);
  }

  // Media story (image/video): the URL was already produced by the standard
  // uploads pipeline — validated by the route schema.
  const mediaUrl = (input.mediaUrl ?? '').trim();
  if (mediaUrl.length === 0) {
    throw ApiError.validation('Envie uma foto ou um vídeo para o Story.');
  }
  // The 2-minute cap for video stories is enforced by the /uploads/video
  // route when the file arrives; re-checking the declared duration here
  // keeps a replayed/stale URL from slipping past a modified client.
  if (type === 'video') {
    validateVideoDurationMs(input.durationMs ?? null);
  }
  const story = await prisma.story.create({
    data: {
      userId,
      type,
      mediaUrl,
      mediaType: type,
      thumbnailUrl: input.thumbnailUrl ?? null,
      caption: input.caption?.trim().slice(0, 200) ?? '',
      expiresAt: new Date(Date.now() + STORY_TTL_MS),
    },
    include: { user: { select: AUTHOR_SELECT } },
  });
  return toStoryItem(story as unknown as StoryRow, userId, false);
}

export interface StoryGroup {
  author: StoryAuthor;
  stories: StoryItem[];
  allViewed: boolean;
}

/**
 * Active stories (not expired) grouped by author, as the feed header
 * expects. Ordering: authors with UNVIEWED stories first, then by most
 * recent — the standard stories logic, kept intentionally simple.
 */
export async function listActiveStories(
  viewerId: string | undefined,
): Promise<{ groups: StoryGroup[] }> {
  const stories = await prisma.story.findMany({
    where: { expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'asc' },
    include: { user: { select: AUTHOR_SELECT } },
  });
  if (stories.length === 0) return { groups: [] };

  // One lightweight query for the viewer's seen markers (no N+1), plus the
  // like state — both scoped to the requesting user.
  const storyIds = stories.map((sn) => sn.id);
  const viewedIds = new Set<string>();
  const likedIds = new Set<string>();
  if (viewerId) {
    const [views, likes] = await Promise.all([
      prisma.storyView.findMany({
        where: { userId: viewerId, storyId: { in: storyIds } },
        select: { storyId: true },
      }),
      prisma.storyLike.findMany({
        where: { userId: viewerId, storyId: { in: storyIds } },
        select: { storyId: true },
      }),
    ]);
    for (const v of views) viewedIds.add(v.storyId);
    for (const l of likes) likedIds.add(l.storyId);
  }
  // Like counts in ONE grouped query.
  const likeCounts = new Map<string, number>();
  const grouped = await prisma.storyLike.groupBy({
    by: ['storyId'],
    where: { storyId: { in: storyIds } },
    _count: { storyId: true },
  });
  for (const g of grouped) likeCounts.set(g.storyId, g._count.storyId);

  const byAuthor = new Map<string, StoryGroup>();
  for (const story of stories) {
    const viewed = viewerId ? viewedIds.has(story.id) : false;
    const item = toStoryItem(
      story as unknown as StoryRow,
      viewerId ?? '',
      viewed,
      likedIds.has(story.id),
      likeCounts.get(story.id) ?? 0,
    );
    const existing = byAuthor.get(story.userId);
    if (existing) {
      existing.stories.push(item);
      if (!viewed) existing.allViewed = false;
    } else {
      byAuthor.set(story.userId, {
        author: item.author,
        stories: [item],
        allViewed: viewed,
      });
    }
  }

  const groups = Array.from(byAuthor.values()).map((g) => ({
    ...g,
    // Newest-first WITHIN the group (the viewer advances newest → oldest,
    // like every stories UI).
    stories: [...g.stories].sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : -1,
    ),
  }));

  groups.sort((a, b) => {
    if (a.allViewed !== b.allViewed) return a.allViewed ? 1 : -1;
    const aLatest = a.stories[0]?.createdAt ?? '';
    const bLatest = b.stories[0]?.createdAt ?? '';
    return aLatest < bLatest ? 1 : -1;
  });

  return { groups };
}

/** Marks a story as seen by [userId]. Server validates existence/expiry. */
export async function markStoryViewed(
  userId: string,
  storyId: string,
): Promise<void> {
  const story = await prisma.story.findUnique({
    where: { id: storyId },
    select: { id: true, expiresAt: true },
  });
  if (!story || story.expiresAt <= new Date()) {
    throw ApiError.notFound('Story não encontrado.');
  }
  await prisma.storyView.upsert({
    where: { userId_storyId: { userId, storyId } },
    update: {},
    create: { userId, storyId },
  });
}

/** Deletes a story. Only the OWNER may delete — verified server-side. */
export async function deleteStory(userId: string, storyId: string): Promise<void> {
  const story = await prisma.story.findUnique({
    where: { id: storyId },
    select: { userId: true, mediaUrl: true, thumbnailUrl: true },
  });
  if (!story) throw ApiError.notFound('Story não encontrado.');
  if (story.userId !== userId) {
    throw ApiError.forbidden('Você não pode excluir o Story de outro usuário.');
  }
  await prisma.story.delete({ where: { id: storyId } });
  await cleanupUnusedMedia([story.mediaUrl, story.thumbnailUrl]);
}

/**
 * Deletes every expired story (views go by cascade) and its abandoned media.
 * Called from the list endpoint so nothing lingers without a scheduler.
 */
export async function purgeExpiredStories(): Promise<number> {
  const expired = await prisma.story.findMany({
    where: { expiresAt: { lte: new Date() } },
    select: { id: true, mediaUrl: true, thumbnailUrl: true },
  });
  if (expired.length === 0) return 0;

  await prisma.story.deleteMany({ where: { id: { in: expired.map((s) => s.id) } } });

  const urls = new Set<string>();
  for (const s of expired) {
    urls.add(s.mediaUrl);
    if (s.thumbnailUrl) urls.add(s.thumbnailUrl);
  }
  await cleanupUnusedMedia(Array.from(urls));
  return expired.length;
}

/**
 * Best-effort removal of media files that NOTHING else references (another
 * story, a post, or a profile avatar). Shared files are always kept.
 */
async function cleanupUnusedMedia(urls: (string | null)[]): Promise<void> {
  for (const url of urls) {
    if (!url) continue;
    const stillUsed =
      (await prisma.story.count({
        where: { OR: [{ mediaUrl: url }, { thumbnailUrl: url }] },
      })) > 0 ||
      (await prisma.post.count({
        where: { OR: [{ imageUrl: url }, { videoUrl: url }, { thumbnailUrl: url }] },
      })) > 0 ||
      (await prisma.user.count({ where: { avatarUrl: url } })) > 0;
    if (!stillUsed) await deleteLocalFileByUrl(url).catch(() => void 0);
  }
}

// ── Likes (same semantics as the post feed) ──────────────────
/**
 * Toggles a like on a story. Mirrors the post-like behaviour exactly:
 * one row per (user, story) enforced by a unique constraint, so repeated
 * taps can never duplicate a like; toggling again removes it.
 * Only ACTIVE stories accept likes (server-side expiry check).
 */
export async function toggleStoryLike(
  userId: string,
  storyId: string,
): Promise<{ liked: boolean; likeCount: number }> {
  const story = await prisma.story.findUnique({
    where: { id: storyId },
    select: { id: true, expiresAt: true },
  });
  if (!story || story.expiresAt <= new Date()) {
    throw ApiError.notFound('Story não encontrado.');
  }

  const existing = await prisma.storyLike.findUnique({
    where: { userId_storyId: { userId, storyId } },
    select: { id: true },
  });
  if (existing) {
    await prisma.storyLike.delete({ where: { id: existing.id } });
  } else {
    // upsert (not create) so a concurrent double-tap can never throw a
    // unique-constraint error — the row simply stays singular.
    await prisma.storyLike.upsert({
      where: { userId_storyId: { userId, storyId } },
      update: {},
      create: { userId, storyId },
    });
  }
  const likeCount = await prisma.storyLike.count({ where: { storyId } });
  return { liked: !existing, likeCount };
}

// ── Reply to a story (becomes a REAL chat message) ───────────
/**
 * Replies to a story. The reply is NOT a separate inbox: it is created as a
 * normal DIRECT MESSAGE from the replier to the story's author, carrying the
 * story reference + a lightweight snapshot (type/thumbnail/text preview) so
 * the chat keeps rendering the reference even after the story expires.
 *
 * Reuses the existing conversation + message infrastructure and realtime
 * dispatch, so read state / history / groups rules all stay consistent.
 */
export async function replyToStory(
  userId: string,
  storyId: string,
  text: string,
): Promise<{ message: unknown; conversationId: string; recipientId: string }> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw ApiError.validation('Escreva uma resposta.');
  }
  if (trimmed.length > STORY_REPLY_LIMIT) {
    throw ApiError.validation(
      `A resposta deve ter no máximo ${STORY_REPLY_LIMIT} caracteres.`,
    );
  }

  const story = await prisma.story.findUnique({
    where: { id: storyId },
    select: {
      id: true,
      userId: true,
      type: true,
      mediaUrl: true,
      mediaType: true,
      text: true,
      thumbnailUrl: true,
      expiresAt: true,
    },
  });
  if (!story || story.expiresAt <= new Date()) {
    throw ApiError.notFound('Story não encontrado.');
  }
  if (story.userId === userId) {
    throw ApiError.invalidRequest('Você não pode responder ao seu próprio Story.');
  }

  // The recipient is ALWAYS the story author — never a client-supplied id.
  const conversation = await getOrCreateConversation(userId, story.userId);

  // Message kind carries the story snapshot; type 'story_reply' lets the app
  // render the contextual reference card instead of a plain bubble.
  const kind = storyKind(story as { type: string; mediaType: string });
  const preview = kind === 'text'
    ? story.text.slice(0, 120)
    : (story.thumbnailUrl ?? story.mediaUrl ?? '').slice(0, 300);

  const message = await sendMessage(
    userId,
    conversation.id,
    trimmed,
    undefined,
    {
      storyId: story.id,
      storyType: kind,
      storyThumbUrl: kind === 'text' ? null : (story.thumbnailUrl ?? story.mediaUrl ?? null),
      storyPreview: preview,
    },
  );

  return {
    message,
    conversationId: conversation.id,
    recipientId: story.userId,
  };
}
