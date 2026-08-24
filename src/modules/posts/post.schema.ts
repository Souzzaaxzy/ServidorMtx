import { z } from 'zod';

// Image reference: absolute http(s) URL (S3/CDN) or a local /static/...
// path served by this API (the default when no public base URL is set).
const imageUrlSchema = z
  .string()
  .max(500, 'URL da imagem muito longa')
  .refine(
    (v) => /^https?:\/\/.+/.test(v) || /^\/static\/[a-zA-Z0-9._-]+$/.test(v),
    'URL da imagem inválida',
  );

export const createPostSchema = z.object({
  text: z.string().trim().max(2000, 'Texto muito longo').optional().nullable(),
  imageUrl: imageUrlSchema.optional().nullable(),
}).refine((data) => (data.text && data.text.length > 0) || data.imageUrl, {
  message: 'A publicação deve conter texto ou imagem.',
});

export const feedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
});

export type CreatePostInput = z.infer<typeof createPostSchema>;
export type FeedQuery = z.infer<typeof feedQuerySchema>;
