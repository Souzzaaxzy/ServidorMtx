import { z } from 'zod';
import { isValidNickname } from '../../utils/normalize.js';

// Avatar/banner reference: either an absolute http(s) URL (S3/CDN) or a local
// /static/... path served by this API. Anything else is rejected.
const imageUrlSchema = (label: string) =>
  z
    .string()
    .max(500, `URL do ${label} muito longa`)
    .refine(
      (v) => /^https?:\/\/.+/.test(v) || /^\/static\/[a-zA-Z0-9._-]+$/.test(v),
      `URL do ${label} inválida`,
    );

export const updateProfileSchema = z.object({
  nickname: z.string().refine(isValidNickname, 'Usuário inválido').optional(),
  bio: z.string().trim().max(300, 'Bio muito longa').optional().nullable(),
  avatarUrl: imageUrlSchema('avatar').optional().nullable(),
  // Wide profile cover image. Same validation rules as the avatar.
  bannerUrl: imageUrlSchema('banner').optional().nullable(),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
