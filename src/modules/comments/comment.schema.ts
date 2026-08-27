import { z } from 'zod';

export const createCommentSchema = z.object({
  text: z.string().trim().min(1, 'Comentário vazio').max(1000, 'Comentário muito longo'),
});

export const listCommentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

export const commentIdParamsSchema = z.object({
  id: z.string().min(1),
});

export const parentCommentParamsSchema = z.object({
  parentId: z.string().min(1),
});

export type CommentIdParams = z.infer<typeof commentIdParamsSchema>;
export type ParentCommentParams = z.infer<typeof parentCommentParamsSchema>;

export type CreateCommentInput = z.infer<typeof createCommentSchema>;
export type ListCommentsQuery = z.infer<typeof listCommentsQuerySchema>;
