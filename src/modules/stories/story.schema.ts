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
    // 'image' | 'video' | 'text'. When omitted it is inferred from mediaType
    // (backwards compatible with the previous media-only payload).
    type: z.enum(['image', 'video', 'text']).optional(),
    mediaUrl: mediaUrlSchema.optional().nullable(),
    mediaType: z.enum(['image', 'video']).default('image'),
    text: z.string().trim().max(300, 'Texto muito longo').optional().nullable(),
    // Real media duration of a VIDEO (ms). The service re-validates the
    // 2-minute cap here so a modified client can never bypass the limit.
    durationMs: z.coerce
      .number()
      .int()
      .positive()
      .max(3_600_000)
      .optional()
      .nullable(),
    thumbnailUrl: imageUrlSchema.optional().nullable(),
    caption: z.string().trim().max(200, 'Legenda muito longa').optional().nullable(),
  })
  .refine((d) => !d.thumbnailUrl || d.mediaType === 'video', {
    message: 'A capa só pode ser definida para Stories com vídeo.',
  })
  .refine((d) => {
    const type = d.type ?? d.mediaType;
    if (type === 'text') return true; // text is validated in the service
    return !!d.mediaUrl;
  }, { message: 'Envie uma foto ou um vídeo para o Story.' })
  .refine((d) => !(d.type === 'text' && d.mediaUrl), {
    message: 'Um Story de texto não pode ter mídia.',
  });

export type CreateStoryInput = z.infer<typeof createStorySchema>;

/** A reply to a story — becomes a REAL direct message to its author. */
export const replyStorySchema = z.object({
  text: z.string().trim().min(1, 'Escreva uma resposta.').max(500, 'Resposta muito longa'),
});
