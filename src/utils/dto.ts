import type { Comment, FriendRequest, Notification, Post, User } from '../generated/index.js';

// ── Nickname colors ──────────────────────────────────────────
// A user's nickname color is the cosmetic equipped in the NAME_COLOR slot;
// the equipped item's assetUrl carries the hex value (the server owns the
// palette — clients never send raw hex). Every payload that renders a
// nickname embeds the OWNER's resolved color so each user keeps their own
// color everywhere (feed, comments, friends, notifications, search, ...).
export const NAME_COLOR_SLOT = 'NAME_COLOR';

// Shared select for "user summary + equipped name color". Spreading this
// into an author/actor select adds the one equipped NAME_COLOR row (if
// any) with just the fields needed to resolve the hex.
export const NAME_COLOR_SELECT = {
  equippedItems: {
    where: { slot: NAME_COLOR_SLOT },
    select: { item: { select: { assetUrl: true } } },
  },
} as const;

export const AUTHOR_SELECT = {
  id: true,
  name: true,
  username: true,
  avatarUrl: true,
  ...NAME_COLOR_SELECT,
} as const;

export type WithNameColor = {
  equippedItems?: { item: { assetUrl: string } }[];
};

// Resolves the equipped name color to its hex value, or null when the user
// has none equipped (→ the app's default nickname color).
export function nameColorHex(user: WithNameColor): string | null {
  return user.equippedItems?.[0]?.item.assetUrl ?? null;
}

// Public user shape — never exposes passwordHash, recoveryCodeHash or role
// internals to other users.
export interface PublicUser {
  id: string;
  name: string;
  username: string;
  avatarUrl: string | null;
  bio: string;
  createdAt: string;
  nameColor: string | null;
}

export function toPublicUser(
  user: Pick<User, 'id' | 'name' | 'username' | 'avatarUrl' | 'bio' | 'createdAt'> &
    WithNameColor,
): PublicUser {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    avatarUrl: user.avatarUrl,
    bio: user.bio,
    createdAt: user.createdAt.toISOString(),
    nameColor: nameColorHex(user),
  };
}

// Authenticated user — includes role (only the current user's own data).

// A cosmetic equipped in a slot (AVATAR_FRAME, BADGE, PROFILE_EFFECT, …).
// Generic by design: new cosmetic types are data, not code — the app maps
// slots to renderers (AvatarFrame, Badge, …) without a server change.
export interface EquippedCosmetic {
  itemId: string;
  name: string;
  assetUrl: string;
  rarity: string;
}

export type CustomizationMap = Record<string, EquippedCosmetic>;

type WithEquippedItems = {
  equippedItems?: {
    slot: string;
    item: { id: string; name: string; assetUrl: string; rarity: string };
  }[];
};

export function customizationMap(user: WithEquippedItems): CustomizationMap {
  const map: CustomizationMap = {};
  for (const e of user.equippedItems ?? []) {
    map[e.slot] = {
      itemId: e.item.id,
      name: e.item.name,
      assetUrl: e.item.assetUrl,
      rarity: e.item.rarity,
    };
  }
  return map;
}

// Profile user — a public user plus real aggregate counters. The profile
// screen renders Amigos/Posts from these; counting is done server-side
// (accepted friendships only, all posts of the user). `customization`
// carries the VIEWED user's equipped cosmetics so any profile renders them.
export interface ProfileUser extends PublicUser {
  friendsCount: number;
  postsCount: number;
  customization: CustomizationMap;
}

export function toProfileUser(
  user: User & WithEquippedItems,
  counts: { friendsCount: number; postsCount: number },
): ProfileUser {
  return { ...toPublicUser(user), ...counts, customization: customizationMap(user) };
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
  author: Pick<PublicUser, 'id' | 'name' | 'username' | 'avatarUrl' | 'nameColor'>;
  likeCount: number;
  liked: boolean;
  commentCount: number;
}

export interface PostDetail extends FeedPost {
  updatedAt: string;
}

export function toFeedPost(
  post: Post & {
    user: Pick<User, 'id' | 'name' | 'username' | 'avatarUrl'> & WithNameColor;
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
      nameColor: nameColorHex(post.user),
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
  author: Pick<PublicUser, 'id' | 'name' | 'username' | 'avatarUrl' | 'nameColor'>;
}

export function toPostComment(
  comment: Comment & {
    user: Pick<User, 'id' | 'name' | 'username' | 'avatarUrl'> & WithNameColor;
  },
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
      nameColor: nameColorHex(comment.user),
    },
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
  sender: Pick<PublicUser, 'id' | 'name' | 'username' | 'avatarUrl' | 'nameColor'>;
}

export function toFriendRequestItem(
  request: FriendRequest & {
    sender: Pick<User, 'id' | 'name' | 'username' | 'avatarUrl'> & WithNameColor;
  },
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
      nameColor: nameColorHex(request.sender),
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
  actor: Pick<PublicUser, 'id' | 'name' | 'username' | 'avatarUrl' | 'nameColor'>;
}

export function toNotificationItem(
  notification: Notification & {
    actor: Pick<User, 'id' | 'name' | 'username' | 'avatarUrl'> & WithNameColor;
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
      nameColor: nameColorHex(notification.actor),
    },
  };
}

export { ACTOR_SELECT as NOTIFICATION_ACTOR_SELECT };
