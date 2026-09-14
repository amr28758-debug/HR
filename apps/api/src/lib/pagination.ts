import { z } from 'zod';

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
});
export type PaginationQuery = z.infer<typeof paginationQuery>;

export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({ data: z.array(item), meta: z.object({ page: z.number(), pageSize: z.number(), total: z.number(), totalPages: z.number() }) });
}

export function pageMeta(q: PaginationQuery, total: number) {
  return { page: q.page, pageSize: q.pageSize, total, totalPages: Math.max(1, Math.ceil(total / q.pageSize)) };
}

export function offset(q: PaginationQuery): number {
  return (q.page - 1) * q.pageSize;
}

/** Whitelist sort columns to prevent injection. */
export function sortColumn<T extends string>(q: PaginationQuery, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(q.sort ?? '') ? (q.sort as T) : fallback;
}

export const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional(), requestId: z.string().optional() }) });
export const idParam = z.object({ id: z.string().uuid() });
