import type { Comment, FriendRequest, Notification, Post, User } from '../generated/index.js';
import { formatPublicId } from './public-id.js';

// Author/public-user select. Every payload that renders a user (feed,
// comments, friends, notifications, search, chat) uses this, so the shape
// stays consistent and never leaks private fields.
export const AUTHOR_SELECT = {
  id: true,
  // The public `#id` travels with every author payload so the app can show it
  // (profile, search results) without an extra request.
  publicId: true,
  nickname: true,
  avatarUrl: true,
  // Included so every author/public-user payload can build a complete
  // PublicUser (the profile screen renders the banner; feed/search/friends
  // simply ignore it when not needed).
  bannerUrl: true,
} as const;

// Public user shape — never exposes passwordHash, recoveryCodeHash or role
// internals to other users.
export interface PublicUser {
  id: string;
  /** Sequential public id (number), e.g. 1. */
  publicId: number;
  /** The public id formatted for display: `#00000001`. */
  publicIdLabel: string;
  nickname: string;
  avatarUrl: string | null;
  /** Wide profile cover image. Null → the app draws its default banner. */
  bannerUrl: string | null;
  bio: string;
  createdAt: string;
}

export function toPublicUser(
  user: Pick<
    User,
    'id' | 'publicId' | 'nickname' | 'avatarUrl' | 'bannerUrl' | 'bio' | 'createdAt'
  >,
): PublicUser {
  return {
    id: user.id,
    publicId: user.publicId,
    publicIdLabel: formatPublicId(user.publicId),
    nickname: user.nickname,
    avatarUrl: user.avatarUrl,
    bannerUrl: user.bannerUrl,
    bio: user.bio,
    createdAt: user.createdAt.toISOString(),
  };
}

// Authenticated user — includes role (only the current user's own data).
export interface AuthUser extends PublicUser {
  role: string;
  updatedAt: string;
}

export function toAuthUser(user: User): AuthUser {
  return {
    ...toPublicUser(user),
    role: user.role,
    updatedAt: user.updatedAt.toISOString(),
  };
}

// Profile user — a public user plus real aggregate counters. The profile
// screen renders Amigos/Posts from these; counting is done server-side
// (accepted friendships only, all posts of the user).
export interface ProfileUser extends PublicUser {
  friendsCount: number;
  postsCount: number;
  /** A música fixada no perfil (trecho), ou null quando não há. */
  music: ProfileMusicPayload | null;
}

// The pinned profile song, embedded in the profile payload so the screen can
// render the play button + name without an extra request. The audio URL is
// served by this API (a short excerpt, never the full track).
export interface ProfileMusicPayload {
  title: string;
  artist: string;
  coverUrl: string | null;
  audioUrl: string;
  durationMs: number;
  startMs: number;
  /** O arquivo é a faixa inteira; tocar só [startMs, startMs+durationMs). */
  playWindowOnly: boolean;
  sourceUrl: string;
  sourceId: string;
}

type WithProfileMusic = {
  profileMusic?: {
    title: string;
    artist: string;
    coverUrl: string | null;
    audioUrl: string;
    durationMs: number;
    startMs: number;
    playWindowOnly: boolean;
    sourceUrl: string;
    sourceId: string;
  } | null;
};

export function toProfileUser(
  user: User & WithProfileMusic,
  counts: { friendsCount: number; postsCount: number },
): ProfileUser {
  return {
    ...toPublicUser(user),
    ...counts,
    music: user.profileMusic
      ? {
          title: user.profileMusic.title,
          artist: user.profileMusic.artist,
          coverUrl: user.profileMusic.coverUrl,
          audioUrl: user.profileMusic.audioUrl,
          durationMs: user.profileMusic.durationMs,
          startMs: user.profileMusic.startMs,
          playWindowOnly: user.profileMusic.playWindowOnly,
          sourceUrl: user.profileMusic.sourceUrl,
          sourceId: user.profileMusic.sourceId,
        }
      : null,
  };
}

export interface FeedPost {
  id: string;
  text: string | null;
  imageUrl: string | null;
  videoUrl: string | null;
  thumbnailUrl: string | null;
  createdAt: string;
  author: Pick<PublicUser, 'id' | 'nickname' | 'avatarUrl'>;
  likeCount: number;
  liked: boolean;
  commentCount: number;
}

export interface PostDetail extends FeedPost {
  updatedAt: string;
}

export function toFeedPost(
  post: Post & {
    user: Pick<User, 'id' | 'nickname' | 'avatarUrl'>;
    _count?: { likes: number; comments: number };
    likes?: { userId: string }[];
  },
  currentUserId?: string,
): FeedPost {
  const liked = currentUserId
    ? (post.likes?.some((l) => l.userId === currentUserId) ?? false)
    : false;
  return {
    id: post.id,
    text: post.text,
    imageUrl: post.imageUrl,
    videoUrl: post.videoUrl,
    thumbnailUrl: post.thumbnailUrl,
    createdAt: post.createdAt.toISOString(),
    author: {
      id: post.user.id,
      nickname: post.user.nickname,
      avatarUrl: post.user.avatarUrl,
    },
    likeCount: post._count?.likes ?? 0,
    liked,
    commentCount: post._count?.comments ?? 0,
  };
}

export interface PostComment {
  id: string;
  text: string;
  createdAt: string;
  // Non-null when the comment is a REPLY to another comment on the same post.
  parentCommentId: string | null;
  author: Pick<PublicUser, 'id' | 'nickname' | 'avatarUrl'>;
  // Total like count on this comment (server-computed, the official source).
  likeCount: number;
  // Whether the AUTHENTICATED viewer has liked this comment. Only populated
  // when an authenticated viewer is passed in — otherwise false.
  liked: boolean;
  // Number of non-deleted replies on this comment (server-computed via the
  // same efficient `_count` include — never a per-comment query). The app
  // shows "ver respostas" ONLY when this is > 0.
  replyCount: number;
}

export function toPostComment(
  comment: Comment & {
    user: Pick<User, 'id' | 'nickname' | 'avatarUrl'>;
    _count: { commentLikes: number; replies: number };
    commentLikes?: { userId: string }[];
  },
  viewerId?: string,
): PostComment {
  const liked = Array.isArray(comment.commentLikes)
    ? comment.commentLikes.some((l) => l.userId === viewerId)
    : false;
  return {
    id: comment.id,
    text: comment.text,
    createdAt: comment.createdAt.toISOString(),
    parentCommentId: comment.parentCommentId,
    author: {
      id: comment.user.id,
      nickname: comment.user.nickname,
      avatarUrl: comment.user.avatarUrl,
    },
    likeCount: comment._count.commentLikes,
    liked,
    replyCount: comment._count.replies,
  };
}

// ── Social: friend requests & notifications ──────────────────
// The shapes the APK consumes. The actor (other user) is embedded in every
// notification so the client never needs a second lookup; friend request
// status is embedded when the notification references one.

// Actor/sender selects embed the actor's own name color too, so every
// notification/request renders each user with THEIR color.
const ACTOR_SELECT = AUTHOR_SELECT;

export interface FriendRequestItem {
  id: string;
  status: string;
  createdAt: string;
  sender: Pick<PublicUser, 'id' | 'nickname' | 'avatarUrl'>;
}

export function toFriendRequestItem(
  request: FriendRequest & {
    sender: Pick<User, 'id' | 'nickname' | 'avatarUrl'>;
  },
): FriendRequestItem {
  return {
    id: request.id,
    status: request.status,
    createdAt: request.createdAt.toISOString(),
    sender: {
      id: request.sender.id,
      nickname: request.sender.nickname,
      avatarUrl: request.sender.avatarUrl,
    },
  };
}

export interface NotificationItem {
  id: string;
  type: string;
  read: boolean;
  createdAt: string;
  postId: string | null;
  commentId: string | null;
  friendRequestId: string | null;
  friendRequestStatus: string | null;
  actor: Pick<PublicUser, 'id' | 'nickname' | 'avatarUrl'>;
}

export function toNotificationItem(
  notification: Notification & {
    actor: Pick<User, 'id' | 'nickname' | 'avatarUrl'>;
    friendRequest?: { id: string; status: string } | null;
  },
): NotificationItem {
  return {
    id: notification.id,
    type: notification.type,
    read: notification.read,
    createdAt: notification.createdAt.toISOString(),
    postId: notification.postId,
    commentId: notification.commentId,
    friendRequestId: notification.friendRequestId,
    friendRequestStatus: notification.friendRequest?.status ?? null,
    actor: {
      id: notification.actor.id,
      nickname: notification.actor.nickname,
      avatarUrl: notification.actor.avatarUrl,
    },
  };
}

export { ACTOR_SELECT as NOTIFICATION_ACTOR_SELECT };
