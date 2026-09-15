import { z } from 'zod';

// Media reference: absolute http(s) URL (S3/CDN) or a local /static/...
// path served by this API — the SAME shapes an image/video post accepts, so
// stories reuse the existing upload/storage stack unchanged.
const mediaUrlSchema = z
  .string()
  .max(500, 'URL da mídia muito longa')
  .refine(
    (v) => /^https?:\/\/.+/.test(v) || /^\/static\/[a-zA-Z0-9._/-]+$/.test(v),
    'URL da mídia inválida',
  );

const imageUrlSchema = z
  .string()
  .max(500, 'URL da imagem muito longa')
  .refine(
    (v) => /^https?:\/\/.+/.test(v) || /^\/static\/[a-zA-Z0-9._-]+$/.test(v),
    'URL da imagem inválida',
  );

export const createStorySchema = z
  .object({
    mediaUrl: mediaUrlSchema,
    mediaType: z.enum(['image', 'video']).default('image'),
    thumbnailUrl: imageUrlSchema.optional().nullable(),
    caption: z.string().trim().max(200, 'Legenda muito longa').optional().nullable(),
  })
  .refine((d) => !d.thumbnailUrl || d.mediaType === 'video', {
    message: 'A capa só pode ser definida para Stories com vídeo.',
  });

export type CreateStoryInput = z.infer<typeof createStorySchema>;
