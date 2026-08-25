import type { Comment, FriendRequest, Notification, Post, User } from '../generated/index.js';

// Public user shape — never exposes passwordHash, recoveryCodeHash or role
// internals to other users.
export interface PublicUser {
  id: string;
  name: string;
  username: string;
  avatarUrl: string | null;
  bio: string;
  createdAt: string;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    avatarUrl: user.avatarUrl,
    bio: user.bio,
    createdAt: user.createdAt.toISOString(),
  };
}

// Authenticated user — includes role (only the current user's own data).
// Profile user — a public user plus real aggregate counters. The profile
// screen renders Amigos/Posts from these; counting is done server-side
// (accepted friendships only, all posts of the user).
export interface ProfileUser extends PublicUser {
  friendsCount: number;
  postsCount: number;
}

export function toProfileUser(
  user: User,
  counts: { friendsCount: number; postsCount: number },
): ProfileUser {
  return { ...toPublicUser(user), ...counts };
}

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

export interface FeedPost {
  id: string;
  text: string | null;
  imageUrl: string | null;
  createdAt: string;
  author: Pick<PublicUser, 'id' | 'name' | 'username' | 'avatarUrl'>;
  likeCount: number;
  liked: boolean;
  commentCount: number;
}

export interface PostDetail extends FeedPost {
  updatedAt: string;
}

export function toFeedPost(
  post: Post & {
    user: Pick<User, 'id' | 'name' | 'username' | 'avatarUrl'>;
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
    createdAt: post.createdAt.toISOString(),
    author: {
      id: post.user.id,
      name: post.user.name,
      username: post.user.username,
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
  author: Pick<PublicUser, 'id' | 'name' | 'username' | 'avatarUrl'>;
}

export function toPostComment(
  comment: Comment & { user: Pick<User, 'id' | 'name' | 'username' | 'avatarUrl'> },
): PostComment {
  return {
    id: comment.id,
    text: comment.text,
    createdAt: comment.createdAt.toISOString(),
    author: {
      id: comment.user.id,
      name: comment.user.name,
      username: comment.user.username,
      avatarUrl: comment.user.avatarUrl,
    },
  };
}

// ── Social: friend requests & notifications ──────────────────
// The shapes the APK consumes. The actor (other user) is embedded in every
// notification so the client never needs a second lookup; friend request
// status is embedded when the notification references one.

const ACTOR_SELECT = {
  id: true,
  name: true,
  username: true,
  avatarUrl: true,
} as const;

export interface FriendRequestItem {
  id: string;
  status: string;
  createdAt: string;
  sender: Pick<PublicUser, 'id' | 'name' | 'username' | 'avatarUrl'>;
}

export function toFriendRequestItem(
  request: FriendRequest & { sender: Pick<User, 'id' | 'name' | 'username' | 'avatarUrl'> },
): FriendRequestItem {
  return {
    id: request.id,
    status: request.status,
    createdAt: request.createdAt.toISOString(),
    sender: {
      id: request.sender.id,
      name: request.sender.name,
      username: request.sender.username,
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
  actor: Pick<PublicUser, 'id' | 'name' | 'username' | 'avatarUrl'>;
}

export function toNotificationItem(
  notification: Notification & {
    actor: Pick<User, 'id' | 'name' | 'username' | 'avatarUrl'>;
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
      name: notification.actor.name,
      username: notification.actor.username,
      avatarUrl: notification.actor.avatarUrl,
    },
  };
}

export { ACTOR_SELECT as NOTIFICATION_ACTOR_SELECT };
