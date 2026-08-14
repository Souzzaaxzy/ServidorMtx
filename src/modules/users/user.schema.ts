import { z } from 'zod';
import { isValidUsername } from '../../utils/normalize.js';

export const updateProfileSchema = z.object({
  name: z.string().trim().min(2, 'Nome muito curto').max(80, 'Nome muito longo').optional(),
  username: z.string().refine(isValidUsername, 'Usuário inválido').optional(),
  bio: z.string().trim().max(300, 'Bio muito longa').optional().nullable(),
  avatarUrl: z.string().url().optional().nullable(),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
