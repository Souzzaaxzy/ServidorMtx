// Application-level enum definitions.
//
// Prisma's SQLite connector does not support `enum` types, so the schema
// stores these as plain strings. To keep the rest of the codebase unchanged
// (it references e.g. `XpReason.POST_CREATED` as both a value and a type),
// we define them here as const objects with derived union types and
// re-export them from the modules that previously re-exported the generated
// Prisma enums. The string values MUST match the defaults used in
// prisma/schema.prisma exactly.

export const UserRole = {
  USER: 'USER',
  MODERATOR: 'MODERATOR',
  ADMIN: 'ADMIN',
  OWNER: 'OWNER',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const FriendRequestStatus = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
} as const;
export type FriendRequestStatus =
  (typeof FriendRequestStatus)[keyof typeof FriendRequestStatus];

// Friendship relationship as seen by the viewer on a other user's profile.
export const FriendshipState = {
  NONE: 'NONE',
  OUTGOING_PENDING: 'OUTGOING_PENDING',
  INCOMING_PENDING: 'INCOMING_PENDING',
  FRIENDS: 'FRIENDS',
} as const;
export type FriendshipState =
  (typeof FriendshipState)[keyof typeof FriendshipState];

export const NotificationType = {
  LIKE: 'LIKE',
  COMMENT: 'COMMENT',
  FRIEND_REQUEST: 'FRIEND_REQUEST',
  FRIEND_ACCEPTED: 'FRIEND_ACCEPTED',
} as const;
export type NotificationType =
  (typeof NotificationType)[keyof typeof NotificationType];

export const ItemType = {
  AVATAR_FRAME: 'AVATAR_FRAME',
  PROFILE_BANNER: 'PROFILE_BANNER',
  BADGE: 'BADGE',
  PROFILE_EFFECT: 'PROFILE_EFFECT',
  THEME_ACCCENT: 'THEME_ACCCENT',
  // A solid nickname color. The item's assetUrl carries the hex value
  // (e.g. "#0066FF"); colors are free catalog entries — the server only
  // validates id/active/type on equip, never a client-supplied hex.
  NAME_COLOR: 'NAME_COLOR',
} as const;
export type ItemType = (typeof ItemType)[keyof typeof ItemType];

export const ItemRarity = {
  COMMON: 'COMMON',
  UNCOMMON: 'UNCOMMON',
  RARE: 'RARE',
  EPIC: 'EPIC',
  LEGENDARY: 'LEGENDARY',
} as const;
export type ItemRarity = (typeof ItemRarity)[keyof typeof ItemRarity];

export const XpReason = {
  POST_CREATED: 'POST_CREATED',
  COMMENT_CREATED: 'COMMENT_CREATED',
  LIKE_RECEIVED: 'LIKE_RECEIVED',
  ACHIEVEMENT: 'ACHIEVEMENT',
  EVENT_REWARD: 'EVENT_REWARD',
  GAME_REWARD: 'GAME_REWARD',
  ADMIN_GRANT: 'ADMIN_GRANT',
} as const;
export type XpReason = (typeof XpReason)[keyof typeof XpReason];

export const CoinReason = {
  POST_CREATED: 'POST_CREATED',
  ACHIEVEMENT: 'ACHIEVEMENT',
  EVENT_REWARD: 'EVENT_REWARD',
  GAME_REWARD: 'GAME_REWARD',
  ADMIN_GRANT: 'ADMIN_GRANT',
  ADMIN_REMOVE: 'ADMIN_REMOVE',
  PURCHASE: 'PURCHASE',
  REWARD: 'REWARD',
} as const;
export type CoinReason = (typeof CoinReason)[keyof typeof CoinReason];

export const CoinTransactionType = {
  EARN: 'EARN',
  SPEND: 'SPEND',
  ADMIN_GRANT: 'ADMIN_GRANT',
  ADMIN_REMOVE: 'ADMIN_REMOVE',
  REWARD: 'REWARD',
} as const;
export type CoinTransactionType =
  (typeof CoinTransactionType)[keyof typeof CoinTransactionType];

export const EventStatus = {
  DRAFT: 'DRAFT',
  ACTIVE: 'ACTIVE',
  ENDED: 'ENDED',
  CANCELLED: 'CANCELLED',
} as const;
export type EventStatus = (typeof EventStatus)[keyof typeof EventStatus];

export const MusicVoteDirection = {
  UP: 'UP',
  DOWN: 'DOWN',
} as const;
export type MusicVoteDirection =
  (typeof MusicVoteDirection)[keyof typeof MusicVoteDirection];
