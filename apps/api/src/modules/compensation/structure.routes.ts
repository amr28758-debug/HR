import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import type { DB } from '@burtplace/database';
import { bandPosition, classifyBandStatus, validateBand, validateMeritCells } from '@burtplace/core';
import { errorSchema, idParam } from '../../lib/pagination.js';
import { badRequest, conflict, notFound, unprocessable } from '../../plugins/errors.js';
import { requireAuth, requirePermission } from '../../plugins/rbac.js';
import { bandFor } from './data.js';
import { loadPolicy, loadPolicyVersioned, policySchema, savePolicy, type CompensationPolicy } from './policy.js';

/** Salary structure & configuration: grades, effective-dated bands, job-title → grade mapping, rating levels, merit matrices, promotion & compression rules, policy, approval chains. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.number().nonnegative().max(10_000_000);
const today = () => new Date().toISOString().slice(0, 10);

/** grades.min/mid/max is a cache of the band in force today (read by legacy screens). */
export async function syncGradeCache(db: Kysely<DB>, gradeId: string): Promise<void> {
  const b = await bandFor(db, gradeId, today());
  await db.updateTable('grades').set({ min_salary: b?.min ?? null, mid_salary: b?.mid ?? null, max_salary: b?.max ?? null, ...(b ? { currency: b.currency } : {}) }).where('id', '=', gradeId).execute();
}

export const structureRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const T = ['compensation'];

  // ── Grades ──
  const bandOut = z.object({ id: z.string(), gradeId: z.string(), gradeCode: z.string().optional(), min: z.number(), mid: z.number(), max: z.number(), currency: z.string(), effectiveFrom: z.string(), effectiveTo: z.string().nullable(), status: z.string(), notes: z.string().nullable(), updatedAt: z.string() });
  const bandMap = (b: any) => ({ id: b.id, gradeId: b.grade_id, gradeCode: b.grade_code ?? undefined, min: Number(b.min_salary), mid: Number(b.mid_salary), max: Number(b.max_salary), currency: b.currency, effectiveFrom: b.effective_from, effectiveTo: b.effective_to, status: b.status, notes: b.notes, updatedAt: new Date(b.updated_at).toISOString() });
  const gradeOut = z.object({ id: z.string(), code: z.string(), name: z.string(), description: z.string().nullable(), notes: z.string().nullable(), status: z.string(), sortOrder: z.number(), careerLevelId: z.string().nullable(), currentBand: bandOut.nullable(), employees: z.number(), titles: z.number() });
  r.get('/grades', { preHandler: requirePermission('compensation:read', 'jobs:read'), schema: { tags: T, summary: 'Salary grades with the band in force today, employee and job-title counts', response: { 200: z.array(gradeOut) } } }, async () => {
    const rows = await app.db.selectFrom('grades as g').selectAll('g')
      .select((eb) => [eb.selectFrom('employees').select(eb.fn.countAll<number>().as('n')).whereRef('employees.grade_id', '=', 'g.id').where('employees.deleted_at', 'is', null).where('employees.status', 'in', ['ACTIVE', 'PROBATION', 'CONFIRMED', 'TRANSFERRED', 'PROMOTED']).as('emps'), eb.selectFrom('designations').select(eb.fn.countAll<number>().as('n')).whereRef('designations.default_grade_id', '=', 'g.id').as('titles')])
      .where('g.deleted_at', 'is', null).orderBy('g.sort_order').execute();
    const bands = await app.db.selectFrom('salary_bands').selectAll().where('status', '=', 'ACTIVE').where('deleted_at', 'is', null).where('effective_from', '<=', today()).where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>=', today())])).execute();
    return rows.map((g) => ({ id: g.id, code: g.code, name: g.name, description: g.description, notes: g.notes, status: g.status, sortOrder: g.sort_order, careerLevelId: g.career_level_id, currentBand: (() => { const b = bands.find((x) => x.grade_id === g.id); return b ? bandMap(b) : null; })(), employees: Number(g.emps ?? 0), titles: Number(g.titles ?? 0) }));
  });
  const gradeIn = z.object({ code: z.string().min(1).max(20), name: z.string().min(1).max(100), description: z.string().max(1000).nullable().optional(), notes: z.string().max(2000).nullable().optional(), careerLevelId: z.string().uuid().nullable().optional(), sortOrder: z.number().int().default(100), status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE') });
  r.post('/grades', { preHandler: requirePermission('compensation:config'), schema: { tags: T, summary: 'Create a grade (add its salary band with POST /salary-bands)', body: gradeIn, response: { 201: z.object({ id: z.string() }), 409: errorSchema } } }, async (req, reply) => {
    const b = req.body;
    const g = await app.db.insertInto('grades').values({ code: b.code, name: b.name, description: b.description ?? null, notes: b.notes ?? null, career_level_id: b.careerLevelId ?? null, sort_order: b.sortOrder, status: b.status }).returning('id').executeTakeFirstOrThrow();
    await app.audit(req, { action: 'compensation.grade.create', entityType: 'grade', entityId: g.id, newValue: b });
    return reply.status(201).send({ id: g.id });
  });
  r.put('/grades/:id', { preHandler: requirePermission('compensation:config'), schema: { tags: T, summary: 'Update a grade', params: idParam, body: gradeIn.partial(), response: { 200: z.object({ id: z.string() }) } } }, async (req) => {
    const old = await app.db.selectFrom('grades').selectAll().where('id', '=', req.params.id).where('deleted_at', 'is', null).executeTakeFirst();
    if (!old) throw notFound('Grade', req.params.id);
    const b = req.body;
    await app.db.updateTable('grades').set({ ...(b.code !== undefined && { code: b.code }), ...(b.name !== undefined && { name: b.name }), ...(b.description !== undefined && { description: b.description }), ...(b.notes !== undefined && { notes: b.notes }), ...(b.careerLevelId !== undefined && { career_level_id: b.careerLevelId }), ...(b.sortOrder !== undefined && { sort_order: b.sortOrder }), ...(b.status !== undefined && { status: b.status }) }).where('id', '=', old.id).execute();
    await app.audit(req, { action: 'compensation.grade.update', entityType: 'grade', entityId: old.id, oldValue: { code: old.code, name: old.name, status: old.status, sortOrder: old.sort_order, description: old.description }, newValue: b });
    return { id: old.id };
  });
  r.delete('/grades/:id', { preHandler: requirePermission('compensation:config'), schema: { tags: T, summary: 'Retire a grade (soft delete; refused while employees or job titles use it)', params: idParam, body: z.object({ reason: z.string().min(1).max(500) }), response: { 204: z.null(), 422: errorSchema } } }, async (req, reply) => {
    const used = await app.db.selectFrom('employees').select('id').where('grade_id', '=', req.params.id).where('deleted_at', 'is', null).executeTakeFirst() ?? await app.db.selectFrom('designations').select('id').where('default_grade_id', '=', req.params.id).executeTakeFirst();
    if (used) throw unprocessable('Grade is still assigned to employees or job titles');
    await app.db.updateTable('grades').set({ status: 'INACTIVE', is_active: false, deleted_at: new Date() }).where('id', '=', req.params.id).execute();
    await app.db.updateTable('salary_bands').set({ status: 'RETIRED' }).where('grade_id', '=', req.params.id).where('status', '=', 'ACTIVE').execute();
    await app.audit(req, { action: 'compensation.grade.retire', entityType: 'grade', entityId: req.params.id, reason: req.body.reason });
    return reply.status(204).send(null);
  });

  // ── Salary bands (effective-dated, never overlapping) ──
  r.get('/salary-bands', { preHandler: requirePermission('compensation:read', 'jobs:read'), schema: { tags: T, summary: 'Salary bands (current by default; history=true for all versions)', querystring: z.object({ gradeId: z.string().uuid().optional(), history: z.coerce.boolean().default(false) }), response: { 200: z.array(bandOut) } } }, async (req) => {
    let q = app.db.selectFrom('salary_bands as b').innerJoin('grades as g', 'g.id', 'b.grade_id').selectAll('b').select('g.code as grade_code').where('b.deleted_at', 'is', null);
    if (req.query.gradeId) q = q.where('b.grade_id', '=', req.query.gradeId);
    if (!req.query.history) q = q.where('b.status', '=', 'ACTIVE').where('b.effective_from', '<=', today()).where((eb) => eb.or([eb('b.effective_to', 'is', null), eb('b.effective_to', '>=', today())]));
    return (await q.orderBy('g.sort_order').orderBy('b.effective_from', 'desc').execute()).map(bandMap);
  });
  const bandIn = z.object({ gradeId: z.string().uuid(), min: money, mid: money.optional(), max: money, currency: z.string().length(3).default('AED'), effectiveFrom: isoDate, status: z.enum(['DRAFT', 'ACTIVE']).default('ACTIVE'), notes: z.string().max(2000).optional() });
  r.post('/salary-bands', { preHandler: requirePermission('compensation:config'), schema: { tags: T, summary: 'Add a band version for a grade. An ACTIVE band closes the open-ended previous band the day before.', body: bandIn, response: { 201: bandOut, 400: errorSchema, 409: errorSchema } } }, async (req, reply) => {
    const p = requireAuth(req); const b = req.body;
    const mid = b.mid ?? Math.round(((b.min + b.max) / 2) * 100) / 100;
    const errs = validateBand({ min: b.min, mid, max: b.max });
    if (errs.length) throw badRequest(`Invalid salary band: ${errs.join('; ')}`);
    const g = await app.db.selectFrom('grades').select(['id', 'code']).where('id', '=', b.gradeId).where('deleted_at', 'is', null).executeTakeFirst();
    if (!g) throw notFound('Grade', b.gradeId);
    const row = await app.db.transaction().execute(async (trx) => {
      if (b.status === 'ACTIVE') {
        const prev = await trx.selectFrom('salary_bands').selectAll().where('grade_id', '=', b.gradeId).where('status', '=', 'ACTIVE').where('deleted_at', 'is', null).where('effective_to', 'is', null).executeTakeFirst();
        if (prev && prev.effective_from >= b.effectiveFrom) throw conflict(`An active band for ${g.code} already starts on ${prev.effective_from}; edit it or choose a later effective date`);
        if (prev) await trx.updateTable('salary_bands').set({ effective_to: sql`(${b.effectiveFrom}::date - interval '1 day')::date`, updated_by: p.userId }).where('id', '=', prev.id).execute();
      }
      return trx.insertInto('salary_bands').values({ grade_id: b.gradeId, min_salary: b.min, mid_salary: mid, max_salary: b.max, currency: b.currency, effective_from: b.effectiveFrom, status: b.status, notes: b.notes ?? null, created_by: p.userId, updated_by: p.userId }).returningAll().executeTakeFirstOrThrow();
    });
    await syncGradeCache(app.db, b.gradeId);
    await app.audit(req, { action: 'compensation.band.create', entityType: 'salary_band', entityId: row.id, newValue: { grade: g.code, ...b, mid } });
    return reply.status(201).send(bandMap({ ...row, grade_code: g.code }));
  });
  r.put('/salary-bands/:id', { preHandler: requirePermission('compensation:config'), schema: { tags: T, summary: 'Edit a band (amounts, notes, status, end date). Old and new values are audited.', params: idParam, body: z.object({ min: money.optional(), mid: money.optional(), max: money.optional(), notes: z.string().max(2000).nullable().optional(), status: z.enum(['DRAFT', 'ACTIVE', 'RETIRED']).optional(), effectiveTo: isoDate.nullable().optional(), reason: z.string().min(1).max(500) }), response: { 200: bandOut, 400: errorSchema } } }, async (req) => {
    const p = requireAuth(req);
    const old = await app.db.selectFrom('salary_bands').selectAll().where('id', '=', req.params.id).where('deleted_at', 'is', null).executeTakeFirst();
    if (!old) throw notFound('Salary band', req.params.id);
    const b = req.body;
    const next = { min: b.min ?? Number(old.min_salary), mid: b.mid ?? Number(old.mid_salary), max: b.max ?? Number(old.max_salary) };
    const errs = validateBand(next);
    if (errs.length) throw badRequest(`Invalid salary band: ${errs.join('; ')}`);
    const row = await app.db.updateTable('salary_bands').set({ min_salary: next.min, mid_salary: next.mid, max_salary: next.max, ...(b.notes !== undefined && { notes: b.notes }), ...(b.status && { status: b.status }), ...(b.effectiveTo !== undefined && { effective_to: b.effectiveTo }), updated_by: p.userId }).where('id', '=', old.id).returningAll().executeTakeFirstOrThrow();
    await syncGradeCache(app.db, old.grade_id);
    await app.audit(req, { action: 'compensation.band.update', entityType: 'salary_band', entityId: old.id, oldValue: { min: Number(old.min_salary), mid: Number(old.mid_salary), max: Number(old.max_salary), status: old.status, effectiveTo: old.effective_to, notes: old.notes }, newValue: { ...next, status: row.status, effectiveTo: row.effective_to, notes: row.notes }, reason: b.reason });
    return bandMap(row);
  });
  r.delete('/salary-bands/:id', { preHandler: requirePermission('compensation:config'), schema: { tags: T, summary: 'Retire a band (soft delete — history is kept)', params: idParam, body: z.object({ reason: z.string().min(1).max(500) }), response: { 204: z.null() } } }, async (req, reply) => {
    const old = await app.db.selectFrom('salary_bands').select(['id', 'grade_id', 'status']).where('id', '=', req.params.id).where('deleted_at', 'is', null).executeTakeFirst();
    if (!old) throw notFound('Salary band', req.params.id);
    await app.db.updateTable('salary_bands').set({ status: 'RETIRED', deleted_at: new Date() }).where('id', '=', old.id).execute();
    await syncGradeCache(app.db, old.grade_id);
    await app.audit(req, { action: 'compensation.band.retire', entityType: 'salary_band', entityId: old.id, oldValue: { status: old.status }, reason: req.body.reason });
    return reply.status(204).send(null);
  });

  r.get('/grade-check', { preHandler: requirePermission('compensation:read'), schema: { tags: T, summary: 'Where a proposed salary sits within a grade band (status uses the configured thresholds)', querystring: z.object({ gradeId: z.string().uuid(), basic: z.coerce.number(), date: isoDate.optional() }), response: { 200: z.object({ grade: z.string(), min: z.number().nullable(), mid: z.number().nullable(), max: z.number().nullable(), position: z.enum(['BELOW_MIN', 'IN_BAND', 'ABOVE_MAX', 'NO_BAND']), compaRatio: z.number().nullable(), rangePenetration: z.number().nullable(), status: z.object({ code: z.string(), label: z.string(), color: z.string() }) }) } } }, async (req) => {
    const g = await app.db.selectFrom('grades').select(['id', 'code']).where('id', '=', req.query.gradeId).executeTakeFirst();
    if (!g) throw notFound('Grade', req.query.gradeId);
    const band = await bandFor(app.db, g.id, req.query.date ?? today());
    const policy = await loadPolicy(app.db);
    const pos = band ? bandPosition(req.query.basic, band) : null;
    return { grade: g.code, min: band?.min ?? null, mid: band?.mid ?? null, max: band?.max ?? null, position: !pos ? 'NO_BAND' as const : pos.belowMinBy > 0 ? 'BELOW_MIN' as const : pos.aboveMaxBy > 0 ? 'ABOVE_MAX' as const : 'IN_BAND' as const, compaRatio: pos?.compaRatio ?? null, rangePenetration: pos?.rangePenetration ?? null, status: classifyBandStatus(pos, policy.statusThresholds) };
  });

  // ── Job title → grade mapping (designations.default_grade_id) ──
  r.get('/job-grade-mappings', { preHandler: requirePermission('compensation:read', 'jobs:read'), schema: { tags: T, summary: 'Job titles with their mapped grade and how many employees sit in another grade', response: { 200: z.array(z.object({ designationId: z.string(), code: z.string(), title: z.string(), gradeId: z.string().nullable(), gradeCode: z.string().nullable(), employees: z.number(), employeesWithoutGrade: z.number(), employeesInOtherGrade: z.number() })) } } }, async () => {
    const rows = await sql<any>`SELECT d.id, d.code, d.title, d.default_grade_id, g.code AS grade_code,
        count(e.id) FILTER (WHERE e.id IS NOT NULL)::int AS employees, count(e.id) FILTER (WHERE e.grade_id IS NULL)::int AS no_grade,
        count(e.id) FILTER (WHERE e.grade_id IS NOT NULL AND d.default_grade_id IS NOT NULL AND e.grade_id <> d.default_grade_id)::int AS other_grade
      FROM designations d LEFT JOIN grades g ON g.id = d.default_grade_id
      LEFT JOIN employees e ON e.designation_id = d.id AND e.deleted_at IS NULL AND e.status IN ('ACTIVE','PROBATION','CONFIRMED','TRANSFERRED','PROMOTED')
      GROUP BY d.id, g.code ORDER BY d.title`.execute(app.db);
    return rows.rows.map((x) => ({ designationId: x.id, code: x.code, title: x.title, gradeId: x.default_grade_id, gradeCode: x.grade_code, employees: x.employees, employeesWithoutGrade: x.no_grade, employeesInOtherGrade: x.other_grade }));
  });
  r.put('/job-grade-mappings/:id', { preHandler: requirePermission('compensation:config'), schema: { tags: T, summary: 'Map a job title to a grade. fillMissingEmployeeGrades assigns the grade only to employees who have none (grade changes go through HR requests).', params: idParam, body: z.object({ gradeId: z.string().uuid().nullable(), fillMissingEmployeeGrades: z.boolean().default(false), reason: z.string().min(1).max(500) }), response: { 200: z.object({ designationId: z.string(), gradeId: z.string().nullable(), employeesAssigned: z.number() }) } } }, async (req) => {
    const d = await app.db.selectFrom('designations').select(['id', 'default_grade_id']).where('id', '=', req.params.id).executeTakeFirst();
    if (!d) throw notFound('Job title', req.params.id);
    let assigned = 0;
    await app.db.transaction().execute(async (trx) => {
      await trx.updateTable('designations').set({ default_grade_id: req.body.gradeId }).where('id', '=', d.id).execute();
      if (req.body.fillMissingEmployeeGrades && req.body.gradeId) {
        const g = await trx.selectFrom('grades').select(['code', 'career_level_id']).where('id', '=', req.body.gradeId).executeTakeFirstOrThrow();
        assigned = Number((await trx.updateTable('employees').set({ grade_id: req.body.gradeId, grade: g.code }).where('designation_id', '=', d.id).where('grade_id', 'is', null).where('deleted_at', 'is', null).executeTakeFirst()).numUpdatedRows);
      }
    });
    await app.audit(req, { action: 'compensation.mapping.update', entityType: 'designation', entityId: d.id, oldValue: { gradeId: d.default_grade_id }, newValue: { gradeId: req.body.gradeId, employeesAssigned: assigned }, reason: req.body.reason });
    return { designationId: d.id, gradeId: req.body.gradeId, employeesAssigned: assigned };
  });

  // ── Performance rating levels ──
  const levelIn = z.object({ code: z.string().min(1).max(30).regex(/^[A-Z0-9_]+$/), label: z.string().min(1).max(60), minScore: z.number(), maxScore: z.number(), sortOrder: z.number().int().default(100), isActive: z.boolean().default(true) });
  r.get('/rating-levels', { preHandler: requirePermission('compensation:read'), schema: { tags: T, summary: 'Performance rating levels (review score → named rating used by the merit matrix)', response: { 200: z.array(levelIn) } } }, async () =>
    (await app.db.selectFrom('performance_rating_levels').selectAll().orderBy('sort_order').execute()).map((l) => ({ code: l.code, label: l.label, minScore: Number(l.min_score), maxScore: Number(l.max_score), sortOrder: l.sort_order, isActive: l.is_active })));
  r.put('/rating-levels', { preHandler: requirePermission('compensation:settings'), schema: { tags: T, summary: 'Replace the rating level set (codes used by merit matrices cannot be removed; deactivate instead)', body: z.object({ levels: z.array(levelIn).min(1), reason: z.string().min(1).max(500) }), response: { 200: z.object({ count: z.number() }), 400: errorSchema } } }, async (req) => {
    const ls = [...req.body.levels].filter((l) => l.isActive).sort((a, b) => a.minScore - b.minScore);
    for (const l of req.body.levels) if (l.maxScore < l.minScore) throw badRequest(`${l.code}: maxScore must be ≥ minScore`);
    for (let i = 1; i < ls.length; i++) if (ls[i]!.minScore <= ls[i - 1]!.maxScore) throw badRequest(`Rating levels ${ls[i - 1]!.code} and ${ls[i]!.code} overlap`);
    const old = await app.db.selectFrom('performance_rating_levels').selectAll().execute();
    const used = new Set((await app.db.selectFrom('merit_matrix_cells').select('rating_code').distinct().execute()).map((x) => x.rating_code));
    for (const o of old) if (!req.body.levels.some((l) => l.code === o.code) && used.has(o.code)) throw badRequest(`Rating ${o.code} is used by a merit matrix — deactivate it instead of removing it`);
    await app.db.transaction().execute(async (trx) => {
      for (const o of old) if (!req.body.levels.some((l) => l.code === o.code)) await trx.deleteFrom('performance_rating_levels').where('code', '=', o.code).execute();
      for (const l of req.body.levels) await trx.insertInto('performance_rating_levels').values({ code: l.code, label: l.label, min_score: l.minScore, max_score: l.maxScore, sort_order: l.sortOrder, is_active: l.isActive }).onConflict((oc) => oc.column('code').doUpdateSet({ label: l.label, min_score: l.minScore, max_score: l.maxScore, sort_order: l.sortOrder, is_active: l.isActive })).execute();
    });
    await app.audit(req, { action: 'compensation.rating_levels.update', entityType: 'performance_rating_levels', oldValue: old.map((o) => ({ code: o.code, min: Number(o.min_score), max: Number(o.max_score) })), newValue: req.body.levels, reason: req.body.reason });
    return { count: req.body.levels.length };
  });

  // ── Merit matrices ──
  const cellIn = z.object({ ratingCode: z.string().min(1), minCompa: z.number().nullable(), maxCompa: z.number().nullable(), recommendedPct: z.number().min(0).max(100), maxPct: z.number().min(0).max(100) });
  const matrixIn = z.object({ name: z.string().min(1).max(100), fiscalYear: z.number().int().nullable().optional(), effectiveFrom: isoDate, status: z.enum(['DRAFT', 'ACTIVE', 'RETIRED']).default('DRAFT'), isDefault: z.boolean().default(false), notes: z.string().max(2000).nullable().optional(), cells: z.array(cellIn).min(1) });
  const matrixOut = matrixIn.extend({ id: z.string(), updatedAt: z.string() });
  const loadMatrix = async (id: string) => {
    const m = await app.db.selectFrom('merit_matrices').selectAll().where('id', '=', id).where('deleted_at', 'is', null).executeTakeFirst();
    if (!m) throw notFound('Merit matrix', id);
    const cells = await app.db.selectFrom('merit_matrix_cells as c').innerJoin('performance_rating_levels as l', 'l.code', 'c.rating_code').selectAll('c').where('c.matrix_id', '=', id).orderBy('l.sort_order').orderBy(sql`c.min_compa asc nulls first`).execute();
    return { id: m.id, name: m.name, fiscalYear: m.fiscal_year, effectiveFrom: m.effective_from, status: m.status as 'DRAFT', isDefault: m.is_default, notes: m.notes, updatedAt: new Date(m.updated_at).toISOString(), cells: cells.map((c) => ({ ratingCode: c.rating_code, minCompa: c.min_compa === null ? null : Number(c.min_compa), maxCompa: c.max_compa === null ? null : Number(c.max_compa), recommendedPct: Number(c.recommended_pct), maxPct: Number(c.max_pct) })) };
  };
  r.get('/merit-matrices', { preHandler: requirePermission('compensation:read'), schema: { tags: T, summary: 'Merit matrices with their cells', response: { 200: z.array(matrixOut) } } }, async () => Promise.all((await app.db.selectFrom('merit_matrices').select('id').where('deleted_at', 'is', null).orderBy('created_at', 'desc').execute()).map((m) => loadMatrix(m.id))));
  const saveMatrix = async (id: string | null, b: z.infer<typeof matrixIn>, userId: string) => {
    const errs = validateMeritCells(b.cells);
    if (errs.length) throw badRequest(`Invalid merit matrix: ${errs.join('; ')}`);
    const codes = new Set((await app.db.selectFrom('performance_rating_levels').select('code').execute()).map((x) => x.code));
    for (const c of b.cells) if (!codes.has(c.ratingCode)) throw badRequest(`Unknown rating level ${c.ratingCode}`);
    return app.db.transaction().execute(async (trx) => {
      if (b.isDefault) await trx.updateTable('merit_matrices').set({ is_default: false }).where('is_default', '=', true).$if(!!id, (q) => q.where('id', '<>', id!)).execute();
      const mid = id ? (await trx.updateTable('merit_matrices').set({ name: b.name, fiscal_year: b.fiscalYear ?? null, effective_from: b.effectiveFrom, status: b.status, is_default: b.isDefault, notes: b.notes ?? null }).where('id', '=', id).returning('id').executeTakeFirstOrThrow()).id
        : (await trx.insertInto('merit_matrices').values({ name: b.name, fiscal_year: b.fiscalYear ?? null, effective_from: b.effectiveFrom, status: b.status, is_default: b.isDefault, notes: b.notes ?? null, created_by: userId }).returning('id').executeTakeFirstOrThrow()).id;
      await trx.deleteFrom('merit_matrix_cells').where('matrix_id', '=', mid).execute();
      await trx.insertInto('merit_matrix_cells').values(b.cells.map((c) => ({ matrix_id: mid, rating_code: c.ratingCode, min_compa: c.minCompa, max_compa: c.maxCompa, recommended_pct: c.recommendedPct, max_pct: c.maxPct }))).execute();
      return mid;
    });
  };
  r.post('/merit-matrices', { preHandler: requirePermission('compensation:config'), schema: { tags: T, summary: 'Create a merit matrix (rating × compa-ratio → recommended / maximum increase %)', body: matrixIn, response: { 201: matrixOut, 400: errorSchema } } }, async (req, reply) => {
    const id = await saveMatrix(null, req.body, requireAuth(req).userId);
    await app.audit(req, { action: 'compensation.matrix.create', entityType: 'merit_matrix', entityId: id, newValue: req.body });
    return reply.status(201).send(await loadMatrix(id));
  });
  r.put('/merit-matrices/:id', { preHandler: requirePermission('compensation:config'), schema: { tags: T, summary: 'Replace a merit matrix (old and new cells are audited)', params: idParam, body: matrixIn, response: { 200: matrixOut, 400: errorSchema } } }, async (req) => {
    const old = await loadMatrix(req.params.id);
    await saveMatrix(req.params.id, req.body, requireAuth(req).userId);
    await app.audit(req, { action: 'compensation.matrix.update', entityType: 'merit_matrix', entityId: req.params.id, oldValue: old, newValue: req.body });
    return loadMatrix(req.params.id);
  });
  r.delete('/merit-matrices/:id', { preHandler: requirePermission('compensation:config'), schema: { tags: T, summary: 'Retire a merit matrix', params: idParam, response: { 204: z.null() } } }, async (req, reply) => {
    await app.db.updateTable('merit_matrices').set({ status: 'RETIRED', is_default: false, deleted_at: new Date() }).where('id', '=', req.params.id).execute();
    await app.audit(req, { action: 'compensation.matrix.retire', entityType: 'merit_matrix', entityId: req.params.id });
    return reply.status(204).send(null);
  });

  // ── Promotion salary rules ──
  const ruleIn = z.object({ name: z.string().min(1).max(100), fromGradeId: z.string().uuid().nullable().optional(), toGradeId: z.string().uuid().nullable().optional(), method: z.enum(['PERCENT_INCREASE', 'TO_MINIMUM', 'TO_MIDPOINT', 'PERCENT_OF_MIDPOINT', 'FIXED_AMOUNT', 'GREATER_OF_PERCENT_OR_MINIMUM']), value: z.number().min(0).max(1_000_000).default(0), minIncreasePct: z.number().min(0).max(500).nullable().optional(), maxIncreasePct: z.number().min(0).max(500).nullable().optional(), capAtMax: z.boolean().default(true), priority: z.number().int().default(100), isActive: z.boolean().default(true), notes: z.string().max(1000).nullable().optional() });
  const ruleOut = ruleIn.extend({ id: z.string(), fromGrade: z.string().nullable(), toGrade: z.string().nullable() });
  const ruleMap = (x: any) => ({ id: x.id, name: x.name, fromGradeId: x.from_grade_id, toGradeId: x.to_grade_id, fromGrade: x.from_code ?? null, toGrade: x.to_code ?? null, method: x.method, value: Number(x.value), minIncreasePct: x.min_increase_pct === null ? null : Number(x.min_increase_pct), maxIncreasePct: x.max_increase_pct === null ? null : Number(x.max_increase_pct), capAtMax: x.cap_at_max, priority: x.priority, isActive: x.is_active, notes: x.notes });
  const ruleQ = () => app.db.selectFrom('promotion_salary_rules as r').leftJoin('grades as f', 'f.id', 'r.from_grade_id').leftJoin('grades as t', 't.id', 'r.to_grade_id').selectAll('r').select(['f.code as from_code', 't.code as to_code']);
  r.get('/promotion-rules', { preHandler: requirePermission('compensation:read'), schema: { tags: T, summary: 'Promotion salary rules (most specific rule wins: from+to grade > to grade > from grade > default)', response: { 200: z.array(ruleOut) } } }, async () => (await ruleQ().orderBy('r.priority').execute()).map(ruleMap));
  const ruleVals = (b: z.infer<typeof ruleIn>) => ({ name: b.name, from_grade_id: b.fromGradeId ?? null, to_grade_id: b.toGradeId ?? null, method: b.method, value: b.value, min_increase_pct: b.minIncreasePct ?? null, max_increase_pct: b.maxIncreasePct ?? null, cap_at_max: b.capAtMax, priority: b.priority, is_active: b.isActive, notes: b.notes ?? null });
  r.post('/promotion-rules', { preHandler: requirePermission('compensation:config'), schema: { tags: T, summary: 'Create a promotion salary rule', body: ruleIn, response: { 201: ruleOut } } }, async (req, reply) => {
    const x = await app.db.insertInto('promotion_salary_rules').values({ ...ruleVals(req.body), created_by: requireAuth(req).userId }).returning('id').executeTakeFirstOrThrow();
    await app.audit(req, { action: 'compensation.promotion_rule.create', entityType: 'promotion_salary_rule', entityId: x.id, newValue: req.body });
    return reply.status(201).send(ruleMap(await ruleQ().where('r.id', '=', x.id).executeTakeFirstOrThrow()));
  });
  r.put('/promotion-rules/:id', { preHandler: requirePermission('compensation:config'), schema: { tags: T, summary: 'Update a promotion salary rule', params: idParam, body: ruleIn, response: { 200: ruleOut } } }, async (req) => {
    const old = await ruleQ().where('r.id', '=', req.params.id).executeTakeFirst();
    if (!old) throw notFound('Promotion rule', req.params.id);
    await app.db.updateTable('promotion_salary_rules').set(ruleVals(req.body)).where('id', '=', req.params.id).execute();
    await app.audit(req, { action: 'compensation.promotion_rule.update', entityType: 'promotion_salary_rule', entityId: req.params.id, oldValue: ruleMap(old), newValue: req.body });
    return ruleMap(await ruleQ().where('r.id', '=', req.params.id).executeTakeFirstOrThrow());
  });

  // ── Salary compression rules ──
  const compIn = z.object({ name: z.string().min(1).max(100), scope: z.enum(['DESIGNATION_PAIR', 'GRADE_SEQUENCE', 'JOB_FUNCTION_LEVELS']), lowerDesignationId: z.string().uuid().nullable().optional(), upperDesignationId: z.string().uuid().nullable().optional(), jobFunctionId: z.string().uuid().nullable().optional(), minDifferenceAmount: z.number().min(0).nullable().optional(), minDifferencePct: z.number().min(0).max(500).nullable().optional(), compare: z.enum(['AVERAGE', 'MEDIAN', 'MAX_LOWER_VS_MIN_UPPER']).default('AVERAGE'), isActive: z.boolean().default(true) });
  const compOut = compIn.extend({ id: z.string(), lowerTitle: z.string().nullable(), upperTitle: z.string().nullable() });
  const compQ = () => app.db.selectFrom('salary_compression_rules as r').leftJoin('designations as l', 'l.id', 'r.lower_designation_id').leftJoin('designations as u', 'u.id', 'r.upper_designation_id').selectAll('r').select(['l.title as lower_title', 'u.title as upper_title']);
  const compMap = (x: any) => ({ id: x.id, name: x.name, scope: x.scope, lowerDesignationId: x.lower_designation_id, upperDesignationId: x.upper_designation_id, jobFunctionId: x.job_function_id, lowerTitle: x.lower_title ?? null, upperTitle: x.upper_title ?? null, minDifferenceAmount: x.min_difference_amount === null ? null : Number(x.min_difference_amount), minDifferencePct: x.min_difference_pct === null ? null : Number(x.min_difference_pct), compare: x.compare, isActive: x.is_active });
  const compVals = (b: z.infer<typeof compIn>) => ({ name: b.name, scope: b.scope, lower_designation_id: b.lowerDesignationId ?? null, upper_designation_id: b.upperDesignationId ?? null, job_function_id: b.jobFunctionId ?? null, min_difference_amount: b.minDifferenceAmount ?? null, min_difference_pct: b.minDifferencePct ?? null, compare: b.compare, is_active: b.isActive });
  r.get('/compression-rules', { preHandler: requirePermission('compensation:read'), schema: { tags: T, summary: 'Salary compression rules (job hierarchy + minimum differences)', response: { 200: z.array(compOut) } } }, async () => (await compQ().orderBy('r.created_at').execute()).map(compMap));
  r.post('/compression-rules', { preHandler: requirePermission('compensation:config'), schema: { tags: T, summary: 'Create a compression rule', body: compIn, response: { 201: compOut } } }, async (req, reply) => {
    const x = await app.db.insertInto('salary_compression_rules').values({ ...compVals(req.body), created_by: requireAuth(req).userId }).returning('id').executeTakeFirstOrThrow();
    await app.audit(req, { action: 'compensation.compression_rule.create', entityType: 'salary_compression_rule', entityId: x.id, newValue: req.body });
    return reply.status(201).send(compMap(await compQ().where('r.id', '=', x.id).executeTakeFirstOrThrow()));
  });
  r.put('/compression-rules/:id', { preHandler: requirePermission('compensation:config'), schema: { tags: T, summary: 'Update a compression rule', params: idParam, body: compIn, response: { 200: compOut } } }, async (req) => {
    const old = await compQ().where('r.id', '=', req.params.id).executeTakeFirst();
    if (!old) throw notFound('Compression rule', req.params.id);
    await app.db.updateTable('salary_compression_rules').set(compVals(req.body)).where('id', '=', req.params.id).execute();
    await app.audit(req, { action: 'compensation.compression_rule.update', entityType: 'salary_compression_rule', entityId: req.params.id, oldValue: compMap(old), newValue: req.body });
    return compMap(await compQ().where('r.id', '=', req.params.id).executeTakeFirstOrThrow());
  });

  // ── Policy (thresholds etc.) ──
  r.get('/settings/policy', { preHandler: requirePermission('compensation:read', 'compensation:settings'), schema: { tags: T, summary: 'Compensation policy (status thresholds, band basis, ceiling actions, budget enforcement, segregation of duties)', response: { 200: z.object({ version: z.number(), value: z.record(z.unknown()) }) } } }, async () => {
    const v = await loadPolicyVersioned(app.db, 0);
    return { version: v.version, value: v.value as unknown as Record<string, unknown> };
  });
  r.put('/settings/policy', { preHandler: requirePermission('compensation:settings'), schema: { tags: T, summary: 'Save a new policy version (history kept in app_settings_history)', body: z.object({ value: z.record(z.unknown()), reason: z.string().min(1).max(500) }), response: { 200: z.object({ version: z.number() }), 400: errorSchema } } }, async (req) => {
    const parsed = policySchema.safeParse(req.body.value);
    if (!parsed.success) throw badRequest('Invalid compensation policy', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    const old = await loadPolicy(app.db, 0);
    const res = await savePolicy(app.db, parsed.data as CompensationPolicy, requireAuth(req).userId, req.body.reason);
    await app.audit(req, { action: 'compensation.policy.update', entityType: 'app_settings', entityId: 'compensation.policy', oldValue: old, newValue: parsed.data, reason: req.body.reason });
    return res;
  });
  r.get('/settings/policy/history', { preHandler: requirePermission('compensation:settings', 'audit:read'), schema: { tags: T, summary: 'Policy version history', response: { 200: z.array(z.object({ version: z.number(), changedAt: z.string(), changedBy: z.string().nullable(), reason: z.string().nullable(), value: z.unknown() })) } } }, async () =>
    (await app.db.selectFrom('app_settings_history as h').leftJoin('users as u', 'u.id', 'h.changed_by').select(['h.version', 'h.changed_at', 'u.display_name', 'h.reason', 'h.value']).where('h.key', '=', 'compensation.policy').orderBy('h.version', 'desc').execute()).map((h) => ({ version: h.version, changedAt: new Date(h.changed_at).toISOString(), changedBy: h.display_name ?? null, reason: h.reason, value: h.value })));

  // ── Approval chains for compensation (COMP_*) — thin wrapper over workflow definitions ──
  const stepIn = z.object({ key: z.string().min(1).max(40), approverType: z.enum(['MANAGER', 'ROLE', 'USER']), roleCode: z.string().optional(), userId: z.string().uuid().optional(), statusOnApprove: z.enum(['UNDER_REVIEW', 'HR_APPROVED', 'FINANCE_APPROVED', 'MANAGEMENT_APPROVED', 'APPROVED']).optional(), condition: z.object({ field: z.string(), op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in']), value: z.unknown() }).optional() });
  r.get('/settings/workflows', { preHandler: requirePermission('compensation:read', 'compensation:settings'), schema: { tags: T, summary: 'Active compensation approval chains (COMP_*)', response: { 200: z.array(z.object({ code: z.string(), name: z.string(), version: z.number(), entityType: z.string(), steps: z.array(z.unknown()), conditions: z.array(z.unknown()) })) } } }, async () =>
    (await app.db.selectFrom('workflow_definitions').selectAll().where('code', 'like', 'COMP_%').where('is_active', '=', true).orderBy('code').execute()).map((d) => ({ code: d.code, name: d.name, version: d.version, entityType: d.entity_type, steps: d.steps as unknown[], conditions: (d.conditions ?? []) as unknown[] })));
  r.put('/settings/workflows/:code', { preHandler: requirePermission('compensation:settings'), schema: { tags: T, summary: 'New version of a compensation approval chain. Steps may be conditional (e.g. management only when requiresException = true or annualCost > X).', params: z.object({ code: z.string().regex(/^COMP_[A-Z_]+$/) }), body: z.object({ name: z.string().min(1).max(100), steps: z.array(stepIn).min(1).max(10), conditions: z.array(z.unknown()).default([]), reason: z.string().min(1).max(500) }), response: { 200: z.object({ code: z.string(), version: z.number() }), 400: errorSchema } } }, async (req) => {
    const p = requireAuth(req);
    for (const s of req.body.steps) { if (s.approverType === 'ROLE' && !s.roleCode) throw badRequest(`Step ${s.key}: roleCode is required`); if (s.approverType === 'USER' && !s.userId) throw badRequest(`Step ${s.key}: userId is required`); }
    const prev = await app.db.selectFrom('workflow_definitions').selectAll().where('code', '=', req.params.code).orderBy('version', 'desc').executeTakeFirst();
    const entityType = prev?.entity_type ?? (req.params.code === 'COMP_SALARY_REVIEW' ? 'salary_review' : 'hr_request');
    const version = (prev?.version ?? 0) + 1;
    await app.db.transaction().execute(async (trx) => {
      await trx.updateTable('workflow_definitions').set({ is_active: false }).where('code', '=', req.params.code).execute();
      await trx.insertInto('workflow_definitions').values({ code: req.params.code, version, name: req.body.name, entity_type: entityType, trigger: JSON.stringify({ event: `${req.params.code.toLowerCase()}.submitted` }), conditions: JSON.stringify(req.body.conditions), steps: JSON.stringify(req.body.steps), actions: '[]', created_by: p.userId }).execute();
    });
    await app.audit(req, { action: 'compensation.workflow.update', entityType: 'workflow_definition', entityId: req.params.code, oldValue: prev ? { version: prev.version, steps: prev.steps } : null, newValue: { version, steps: req.body.steps, conditions: req.body.conditions }, reason: req.body.reason });
    return { code: req.params.code, version };
  });
};
