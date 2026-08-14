// Consistent API error handling.
//
// Every error surfaced to the client follows the shape:
//   { "error": { "code": "INVALID_REQUEST", "message": "Dados inválidos." } }
// Throw an `ApiError` from anywhere in the codebase; the global handler
// converts it into the response. Never leak stack traces to clients.

export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, statusCode: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }

  static invalidRequest(message = 'Dados inválidos.', details?: unknown) {
    return new ApiError('INVALID_REQUEST', message, 400, details);
  }
  static validation(message = 'Dados inválidos.', details?: unknown) {
    return new ApiError('VALIDATION_ERROR', message, 400, details);
  }
  static unauthorized(message = 'Não autorizado.') {
    return new ApiError('UNAUTHORIZED', message, 401);
  }
  static forbidden(message = 'Acesso negado.') {
    return new ApiError('FORBIDDEN', message, 403);
  }
  static notFound(message = 'Recurso não encontrado.') {
    return new ApiError('NOT_FOUND', message, 404);
  }
  static conflict(message = 'Conflito de dados.') {
    return new ApiError('CONFLICT', message, 409);
  }
  static payloadTooLarge(message = 'Arquivo muito grande.') {
    return new ApiError('PAYLOAD_TOO_LARGE', message, 413);
  }
  static unsupportedMediaType(message = 'Tipo de arquivo não suportado.') {
    return new ApiError('UNSUPPORTED_MEDIA_TYPE', message, 415);
  }
  static rateLimited(message = 'Muitas requisições. Tente novamente em instantes.') {
    return new ApiError('RATE_LIMITED', message, 429);
  }
  static tooManyRecoveryAttempts(message = 'Muitas tentativas de recuperação. Tente novamente mais tarde.') {
    return new ApiError('RATE_LIMITED', message, 429);
  }
  static internal(message = 'Erro interno do servidor.') {
    return new ApiError('INTERNAL_ERROR', message, 500);
  }
}

// Map common Prisma errors to ApiError for clean responses.
import { Prisma } from '../generated/index.js';

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      // Unique constraint violation — without revealing which field.
      return ApiError.conflict('Usuário já cadastrado.');
    }
    if (err.code === 'P2025') {
      return ApiError.notFound();
    }
  }

  if (err instanceof Error && err.name === 'ZodError') {
    return ApiError.validation('Dados inválidos.', (err as unknown as { issues: unknown }).issues);
  }

  return ApiError.internal();
}
