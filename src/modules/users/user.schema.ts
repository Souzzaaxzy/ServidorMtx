import { z } from 'zod';
import { isValidNickname } from '../../utils/normalize.js';

// Avatar reference: either an absolute http(s) URL (S3/CDN) or a local
// /static/... path served by this API. Anything else is rejected.
const avatarUrlSchema = z
  .string()
  .max(500, 'URL do avatar muito longa')
  .refine(
    (v) => /^https?:\/\/.+/.test(v) || /^\/static\/[a-zA-Z0-9._-]+$/.test(v),
    'URL do avatar inválida',
  );

export const updateProfileSchema = z.object({
  nickname: z.string().refine(isValidNickname, 'Usuário inválido').optional(),
  bio: z.string().trim().max(300, 'Bio muito longa').optional().nullable(),
  avatarUrl: avatarUrlSchema.optional().nullable(),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
