import type { FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';

export class AppError extends Error {
  constructor(public statusCode: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
export const notFound = (what: string, id?: string) => new AppError(404, 'NOT_FOUND', id ? `${what} ${id} not found` : `${what} not found`);
export const badRequest = (message: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', message, details);
export const forbidden = (message = 'Forbidden') => new AppError(403, 'FORBIDDEN', message);
export const unauthorized = (message = 'Unauthorized') => new AppError(401, 'UNAUTHORIZED', message);
export const conflict = (message: string, details?: unknown) => new AppError(409, 'CONFLICT', message, details);
export const unprocessable = (message: string, details?: unknown) => new AppError(422, 'UNPROCESSABLE', message, details);

/** Standard error envelope: { error: { code, message, details?, requestId } } */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    const requestId = req.id;
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details, requestId } });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: err.validation.map((v) => ({ path: v.instancePath, message: v.message })), requestId } });
    }
    if (isResponseSerializationError(err)) {
      req.log.error({ err }, 'response serialization error');
      return reply.status(500).send({ error: { code: 'SERIALIZATION_ERROR', message: 'Response did not match schema', requestId } });
    }
    const anyErr = err as { statusCode?: number; code?: string; message: string };
    // pg unique violation
    if (anyErr.code === '23505') return reply.status(409).send({ error: { code: 'CONFLICT', message: 'A record with the same unique key already exists', requestId } });
    if (anyErr.code === '23P01') return reply.status(409).send({ error: { code: 'CONFLICT', message: 'The record overlaps an existing one (e.g. an active salary band for the same grade and dates)', requestId } });
    if (anyErr.code === '23514') return reply.status(422).send({ error: { code: 'CHECK_VIOLATION', message: 'The values violate a data rule (e.g. min ≤ mid ≤ max, justification required for overrides)', requestId } });
    if (anyErr.code === '23503') return reply.status(422).send({ error: { code: 'FK_VIOLATION', message: 'Referenced record does not exist', requestId } });
    if (anyErr.statusCode && anyErr.statusCode < 500) return reply.status(anyErr.statusCode).send({ error: { code: anyErr.code ?? 'ERROR', message: anyErr.message, requestId } });
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId } });
  });
  app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.url} not found`, requestId: req.id } }));
}
