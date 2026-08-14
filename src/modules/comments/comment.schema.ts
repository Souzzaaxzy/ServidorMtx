import { z } from 'zod';

export const createCommentSchema = z.object({
  text: z.string().trim().min(1, 'Comentário vazio').max(1000, 'Comentário muito longo'),
});

export const listCommentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

export type CreateCommentInput = z.infer<typeof createCommentSchema>;
export type ListCommentsQuery = z.infer<typeof listCommentsQuerySchema>;
