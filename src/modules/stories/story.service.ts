import { prisma } from '../../config/prisma.js';
import { ApiError } from '../../utils/errors.js';
import { deleteLocalFileByUrl } from '../uploads/upload.service.js';
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

/** Author fragment — EXACTLY the shape the feed embeds for a post author. */
export type StoryAuthor = {
  id: string;
  nickname: string;
  avatarUrl: string | null;
} & NicknameCosmeticsPayload;

type StoryRow = {
  id: string;
  userId: string;
  mediaUrl: string;
  mediaType: string;
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
  mediaUrl: string;
  mediaType: 'image' | 'video';
  thumbnailUrl: string | null;
  caption: string;
  expiresAt: string;
  createdAt: string;
  /** Whether the REQUESTING user already opened this story. */
  viewed: boolean;
  /** Whether the requesting user is the author (drives the delete action). */
  mine: boolean;
}

function toStoryItem(story: StoryRow, viewerId: string, viewed: boolean): StoryItem {
  return {
    id: story.id,
    author: {
      id: story.user.id,
      nickname: story.user.nickname,
      avatarUrl: story.user.avatarUrl,
      ...nicknameCosmetics(story.user),
    },
    mediaUrl: story.mediaUrl,
    mediaType: story.mediaType === 'video' ? 'video' : 'image',
    thumbnailUrl: story.thumbnailUrl ?? null,
    caption: story.caption ?? '',
    expiresAt: story.expiresAt.toISOString(),
    createdAt: story.createdAt.toISOString(),
    viewed,
    mine: story.userId === viewerId,
  };
}

export interface CreateStoryInput {
  mediaUrl: string;
  mediaType: 'image' | 'video';
  thumbnailUrl?: string | null;
  caption?: string | null;
}

/** Creates a story for [userId]. Expiry is computed HERE (never the client). */
export async function createStory(
  userId: string,
  input: CreateStoryInput,
): Promise<StoryItem> {
  const story = await prisma.story.create({
    data: {
      userId,
      mediaUrl: input.mediaUrl,
      mediaType: input.mediaType,
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

  // One lightweight query for the viewer's seen markers (no N+1).
  const viewedIds = new Set<string>();
  if (viewerId) {
    const views = await prisma.storyView.findMany({
      where: { userId: viewerId, storyId: { in: stories.map((s) => s.id) } },
      select: { storyId: true },
    });
    for (const v of views) viewedIds.add(v.storyId);
  }

  const byAuthor = new Map<string, StoryGroup>();
  for (const story of stories) {
    const viewed = viewerId ? viewedIds.has(story.id) : false;
    const item = toStoryItem(story as unknown as StoryRow, viewerId ?? '', viewed);
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
