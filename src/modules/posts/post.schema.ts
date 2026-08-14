import { z } from 'zod';

export const createPostSchema = z.object({
  text: z.string().trim().max(2000, 'Texto muito longo').optional().nullable(),
  imageUrl: z.string().url().optional().nullable(),
}).refine((data) => (data.text && data.text.length > 0) || data.imageUrl, {
  message: 'A publicação deve conter texto ou imagem.',
});

export const feedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
});

export type CreatePostInput = z.infer<typeof createPostSchema>;
export type FeedQuery = z.infer<typeof feedQuerySchema>;
