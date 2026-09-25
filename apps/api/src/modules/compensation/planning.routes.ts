import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { calculatePromotionSalary, evaluateEligibility, runScenario, selectPromotionRule, type EligibilityRules, type PromotionRule, type ScenarioEmployee } from '@burtplace/core';
import { errorSchema, idParam, offset, pageMeta, paginated, paginationQuery } from '../../lib/pagination.js';
import { badRequest, notFound, unprocessable } from '../../plugins/errors.js';
import { requireAuth, requirePermission } from '../../plugins/rbac.js';
import { asBand, bandFor, loadProfiles } from './data.js';
import { loadPolicy } from './policy.js';
import { eligibilityIn } from './reviews.routes.js';
import { createReview, populateReview } from './reviews.service.js';
import { defaultMeritCells, loadCostLines, usageOf } from './service.js';

/** Compensation budgets (allocated vs proposed vs approved) and what-if scenarios that never touch salaries. */
export const planningRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const T = ['compensation'];

  // ── Budgets ──
  const usageOut = z.object({ allocated: z.number(), proposedCost: z.number(), approvedCost: z.number(), remaining: z.number(), remainingAfterApproved: z.number(), utilizationPct: z.number().nullable(), approvedUtilizationPct: z.number().nullable(), exceeded: z.boolean() });
  const budgetOut = z.object({ id: z.string(), name: z.string(), fiscalYear: z.number(), budgetType: z.string(), scopeType: z.string(), scopeId: z.string().nullable(), scopeName: z.string().nullable(), amount: z.number(), currency: z.string(), status: z.string(), notes: z.string().nullable(), usage: usageOut, updatedAt: z.string() });
  async function scopeNames(): Promise<Map<string, string>> {
    const [d, g, s] = await Promise.all([app.db.selectFrom('departments').select(['id', 'name']).execute(), app.db.selectFrom('grades').select(['id', 'code as name']).execute(), app.db.selectFrom('sites').select(['id', 'name']).execute()]);
    return new Map([...d, ...g, ...s].map((x) => [x.id, x.name]));
  }
  async function budgetsWithUsage(year: number, id?: string) {
    const policy = await loadPolicy(app.db);
    let q = app.db.selectFrom('compensation_budgets').selectAll().where('fiscal_year', '=', year).where('deleted_at', 'is', null);
    if (id) q = q.where('id', '=', id);
    const rows = await q.orderBy('budget_type').orderBy('scope_type').execute();
    const lines = await loadCostLines(app.db, year, policy.annualizationMonths);
    const names = await scopeNames();
    return rows.map((b) => ({ id: b.id, name: b.name, fiscalYear: b.fiscal_year, budgetType: b.budget_type, scopeType: b.scope_type, scopeId: b.scope_id, scopeName: b.scope_id ? names.get(b.scope_id) ?? null : null, amount: Number(b.amount), currency: b.currency, status: b.status, notes: b.notes, usage: usageOf(b as any, lines), updatedAt: new Date(b.updated_at).toISOString() }));
  }
  r.get('/budgets', { preHandler: requirePermission('compensation:read', 'compensation:budget'), schema: { tags: T, summary: 'Compensation budgets with allocated / proposed / approved / remaining / utilisation', querystring: z.object({ year: z.coerce.number().int().default(new Date().getFullYear() + 1) }), response: { 200: z.array(budgetOut) } } }, async (req) => budgetsWithUsage(req.query.year));
  const budgetIn = z.object({ name: z.string().min(1).max(120), fiscalYear: z.number().int().min(2000).max(2100), budgetType: z.enum(['ANNUAL', 'INCREMENT', 'PROMOTION', 'ADJUSTMENT']), scopeType: z.enum(['COMPANY', 'DEPARTMENT', 'GRADE', 'SITE']).default('COMPANY'), scopeId: z.string().uuid().nullable().optional(), amount: z.number().min(0).max(1_000_000_000), currency: z.string().length(3).default('AED'), status: z.enum(['DRAFT', 'ACTIVE', 'CLOSED']).default('ACTIVE'), notes: z.string().max(2000).nullable().optional() });
  r.post('/budgets', { preHandler: requirePermission('compensation:budget'), schema: { tags: T, summary: 'Create a budget (annual / increment / promotion / adjustment; company, department, grade or site)', body: budgetIn, response: { 201: budgetOut, 409: errorSchema } } }, async (req, reply) => {
    const b = req.body;
    if ((b.scopeType === 'COMPANY') !== !b.scopeId) throw badRequest('scopeId is required for DEPARTMENT/GRADE/SITE budgets and must be empty for COMPANY');
    const x = await app.db.insertInto('compensation_budgets').values({ name: b.name, fiscal_year: b.fiscalYear, budget_type: b.budgetType, scope_type: b.scopeType, scope_id: b.scopeId ?? null, amount: b.amount, currency: b.currency, status: b.status, notes: b.notes ?? null, created_by: requireAuth(req).userId }).returning('id').executeTakeFirstOrThrow();
    await app.audit(req, { action: 'compensation.budget.create', entityType: 'compensation_budget', entityId: x.id, newValue: b });
    return reply.status(201).send((await budgetsWithUsage(b.fiscalYear, x.id))[0]!);
  });
  r.put('/budgets/:id', { preHandler: requirePermission('compensation:budget'), schema: { tags: T, summary: 'Change a budget (old and new values audited)', params: idParam, body: z.object({ name: z.string().min(1).max(120).optional(), amount: z.number().min(0).max(1_000_000_000).optional(), status: z.enum(['DRAFT', 'ACTIVE', 'CLOSED']).optional(), notes: z.string().max(2000).nullable().optional(), reason: z.string().min(1).max(500) }), response: { 200: budgetOut } } }, async (req) => {
    const old = await app.db.selectFrom('compensation_budgets').selectAll().where('id', '=', req.params.id).where('deleted_at', 'is', null).executeTakeFirst();
    if (!old) throw notFound('Budget', req.params.id);
    const b = req.body;
    await app.db.updateTable('compensation_budgets').set({ ...(b.name !== undefined && { name: b.name }), ...(b.amount !== undefined && { amount: b.amount }), ...(b.status !== undefined && { status: b.status }), ...(b.notes !== undefined && { notes: b.notes }), updated_by: requireAuth(req).userId }).where('id', '=', old.id).execute();
    await app.audit(req, { action: 'compensation.budget.update', entityType: 'compensation_budget', entityId: old.id, oldValue: { name: old.name, amount: Number(old.amount), status: old.status }, newValue: b, reason: b.reason });
    return (await budgetsWithUsage(old.fiscal_year, old.id))[0]!;
  });
  r.delete('/budgets/:id', { preHandler: requirePermission('compensation:budget'), schema: { tags: T, summary: 'Remove a budget (soft delete)', params: idParam, body: z.object({ reason: z.string().min(1).max(500) }), response: { 204: z.null() } } }, async (req, reply) => {
    await app.db.updateTable('compensation_budgets').set({ deleted_at: new Date(), status: 'CLOSED' }).where('id', '=', req.params.id).execute();
    await app.audit(req, { action: 'compensation.budget.delete', entityType: 'compensation_budget', entityId: req.params.id, reason: req.body.reason });
    return reply.status(204).send(null);
  });

  // ── Scenarios ──
  const configIn = z.object({ flatPct: z.number().min(0).max(100).nullable().optional(), baseMethod: z.enum(['FLAT_PERCENT', 'MERIT_MATRIX']).optional(), meritMatrixId: z.string().uuid().nullable().optional(), budgetLimit: z.number().min(0).nullable().optional(), ceilingAction: z.enum(['CAP_AT_MAX', 'REQUEST_EXCEPTION']).default('CAP_AT_MAX'), maxIncreasePct: z.number().min(0).max(100).nullable().optional(), eligibilityRules: eligibilityIn, promotions: z.array(z.object({ employeeId: z.string().uuid(), newGradeId: z.string().uuid(), newSalary: z.number().min(0).nullable().optional() })).default([]) });
  const scenarioIn = z.object({ name: z.string().min(1).max(120), description: z.string().max(2000).nullable().optional(), fiscalYear: z.number().int().min(2000).max(2100), method: z.enum(['FLAT_PERCENT', 'MERIT_MATRIX', 'PROMOTION_PLUS_INCREMENT', 'BUDGET_LIMITED']), config: configIn, filters: z.object({ departmentIds: z.array(z.string().uuid()).optional(), siteIds: z.array(z.string().uuid()).optional(), gradeIds: z.array(z.string().uuid()).optional() }).default({}) });
  const summaryOut = z.object({ employees: z.number(), included: z.number(), currentPayroll: z.number(), proposedPayroll: z.number(), monthlyIncrease: z.number(), annualIncrease: z.number(), budget: z.number().nullable(), budgetImpactPct: z.number().nullable(), budgetRemaining: z.number().nullable(), aboveMax: z.number(), requiringException: z.number(), capped: z.number(), scaleFactor: z.number(), averageIncreasePct: z.number() });
  const scenarioOut = z.object({ id: z.string(), name: z.string(), description: z.string().nullable(), fiscalYear: z.number(), method: z.string(), config: z.record(z.unknown()), filters: z.record(z.unknown()), status: z.string(), summary: summaryOut.nullable(), calculatedAt: z.string().nullable(), reviewId: z.string().nullable(), createdAt: z.string() });
  const scenarioMap = (s: any) => ({ id: s.id, name: s.name, description: s.description, fiscalYear: s.fiscal_year, method: s.method, config: s.config ?? {}, filters: s.filters ?? {}, status: s.status, summary: s.summary ?? null, calculatedAt: s.calculated_at ? new Date(s.calculated_at).toISOString() : null, reviewId: s.review_id, createdAt: new Date(s.created_at).toISOString() });
  const getScenario = async (id: string) => { const s = await app.db.selectFrom('compensation_scenarios').selectAll().where('id', '=', id).where('deleted_at', 'is', null).executeTakeFirst(); if (!s) throw notFound('Scenario', id); return s; };

  async function calculate(id: string): Promise<void> {
    const s = await getScenario(id);
    const cfg = configIn.parse(s.config ?? {});
    const filters = (s.filters ?? {}) as { departmentIds?: string[]; siteIds?: string[]; gradeIds?: string[] };
    const policy = await loadPolicy(app.db);
    const asOf = `${s.fiscal_year}-01-01`;
    const profiles = await loadProfiles(app.db, policy, filters, asOf);
    const cells = (s.method === 'MERIT_MATRIX' || cfg.baseMethod === 'MERIT_MATRIX') ? await defaultMeritCells(app.db, cfg.meritMatrixId) : [];
    const rules: PromotionRule[] = (await app.db.selectFrom('promotion_salary_rules').selectAll().where('is_active', '=', true).execute()).map((r) => ({ id: r.id, fromGradeId: r.from_grade_id, toGradeId: r.to_grade_id, priority: r.priority, method: r.method as PromotionRule['method'], value: Number(r.value), minIncreasePct: r.min_increase_pct === null ? null : Number(r.min_increase_pct), maxIncreasePct: r.max_increase_pct === null ? null : Number(r.max_increase_pct), capAtMax: r.cap_at_max }));
    const promos = new Map(cfg.promotions.map((p) => [p.employeeId, p]));
    const emps: ScenarioEmployee[] = [];
    for (const pr of profiles) {
      const el = evaluateEligibility(cfg.eligibilityRules as EligibilityRules, { joiningDate: pr.joiningDate, lastIncreaseDate: pr.lastIncreaseDate, status: pr.status, employmentType: pr.employmentType, ratingScore: pr.ratingScore, ratingCode: pr.ratingCode, lastDisciplinaryDate: pr.lastDisciplinaryDate, onProbation: pr.onProbation, departmentId: pr.departmentId, gradeId: pr.gradeId, siteId: pr.siteId, designationId: pr.designationId, hasSalary: pr.currentSalary !== null }, asOf);
      const base: ScenarioEmployee = { employeeId: pr.employeeId, currentSalary: pr.currentSalary ?? 0, currentGross: pr.grossSalary ?? 0, band: asBand(pr.band), ratingCode: pr.ratingCode, eligible: el.eligible && pr.currentSalary !== null };
      const pm = promos.get(pr.employeeId);
      if (pm && s.method === 'PROMOTION_PLUS_INCREMENT') {
        const tb = await bandFor(app.db, pm.newGradeId, asOf);
        base.promotedBand = asBand(tb);
        base.promotedSalary = pm.newSalary ?? calculatePromotionSalary(base.currentSalary, asBand(tb), selectPromotionRule(rules, pr.gradeId, pm.newGradeId)).recommendedSalary;
        base.eligible = pr.currentSalary !== null;
      }
      emps.push(base);
    }
    const res = runScenario({ method: s.method as any, flatPct: cfg.flatPct ?? null, baseMethod: cfg.baseMethod, meritCells: cells, budgetLimit: cfg.budgetLimit ?? null, ceilingAction: cfg.ceilingAction, maxIncreasePct: cfg.maxIncreasePct ?? null, annualizationMonths: policy.annualizationMonths }, emps);
    await app.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('compensation_scenario_items').where('scenario_id', '=', id).execute();
      const rows = res.items.map((i) => ({ scenario_id: id, employee_id: i.employeeId, current_salary: i.currentSalary, current_gross: i.currentGross, increase_pct: i.increasePct, proposed_salary: i.proposedSalary, final_salary: i.finalSalary, increase: i.increase, exceeds_max_by: i.exceedsMaxBy, requires_exception: i.requiresException, capped: i.capped, promoted: i.promoted, included: i.included }));
      for (let k = 0; k < rows.length; k += 250) if (rows.slice(k, k + 250).length) await trx.insertInto('compensation_scenario_items').values(rows.slice(k, k + 250)).execute();
      await trx.updateTable('compensation_scenarios').set({ summary: JSON.stringify(res.summary), calculated_at: new Date(), status: s.status === 'CONVERTED' ? 'CONVERTED' : 'CALCULATED' }).where('id', '=', id).execute();
    });
  }

  r.get('/scenarios', { preHandler: requirePermission('compensation:read'), schema: { tags: T, summary: 'Compensation scenarios with their summaries', querystring: z.object({ year: z.coerce.number().int().optional() }), response: { 200: z.array(scenarioOut) } } }, async (req) => {
    let q = app.db.selectFrom('compensation_scenarios').selectAll().where('deleted_at', 'is', null);
    if (req.query.year) q = q.where('fiscal_year', '=', req.query.year);
    return (await q.orderBy('created_at', 'desc').execute()).map(scenarioMap);
  });
  r.post('/scenarios', { preHandler: requirePermission('compensation:propose'), schema: { tags: T, summary: 'Create and calculate a scenario — salaries are NOT changed', body: scenarioIn, response: { 201: scenarioOut, 400: errorSchema } } }, async (req, reply) => {
    const b = req.body;
    if ((b.method === 'FLAT_PERCENT' || ((b.method === 'BUDGET_LIMITED' || b.method === 'PROMOTION_PLUS_INCREMENT') && (b.config.baseMethod ?? 'FLAT_PERCENT') === 'FLAT_PERCENT')) && (b.config.flatPct === null || b.config.flatPct === undefined)) throw badRequest('flatPct is required for a flat-percentage scenario');
    if (b.method === 'BUDGET_LIMITED' && (b.config.budgetLimit === null || b.config.budgetLimit === undefined)) throw badRequest('budgetLimit is required for a budget-limited scenario');
    const s = await app.db.insertInto('compensation_scenarios').values({ name: b.name, description: b.description ?? null, fiscal_year: b.fiscalYear, method: b.method, config: JSON.stringify(b.config), filters: JSON.stringify(b.filters), created_by: requireAuth(req).userId }).returning('id').executeTakeFirstOrThrow();
    await calculate(s.id);
    await app.audit(req, { action: 'compensation.scenario.create', entityType: 'compensation_scenario', entityId: s.id, newValue: b });
    return reply.status(201).send(scenarioMap(await getScenario(s.id)));
  });
  r.get('/scenarios/compare', { preHandler: requirePermission('compensation:read'), schema: { tags: T, summary: 'Compare scenario summaries side by side', querystring: z.object({ ids: z.string().min(1) }), response: { 200: z.array(scenarioOut) } } }, async (req) => {
    const ids = req.query.ids.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 6);
    return (await app.db.selectFrom('compensation_scenarios').selectAll().where('id', 'in', ids).where('deleted_at', 'is', null).execute()).map(scenarioMap);
  });
  r.get('/scenarios/:id', { preHandler: requirePermission('compensation:read'), schema: { tags: T, summary: 'Scenario', params: idParam, response: { 200: scenarioOut } } }, async (req) => scenarioMap(await getScenario(req.params.id)));
  r.get('/scenarios/:id/items', { preHandler: [requirePermission('compensation:read'), requirePermission('salary:read')], schema: { tags: T, summary: 'Scenario employee lines (restricted: salary:read)', params: idParam, querystring: paginationQuery.merge(z.object({ attention: z.coerce.boolean().optional() })), response: { 200: paginated(z.object({ employeeId: z.string(), employeeNo: z.string(), name: z.string(), department: z.string().nullable(), grade: z.string().nullable(), currentSalary: z.number(), currentGross: z.number(), increasePct: z.number(), proposedSalary: z.number(), finalSalary: z.number(), increase: z.number(), exceedsMaxBy: z.number(), requiresException: z.boolean(), capped: z.boolean(), promoted: z.boolean(), included: z.boolean() })) } } }, async (req) => {
    let b = app.db.selectFrom('compensation_scenario_items as i').innerJoin('employees as e', 'e.id', 'i.employee_id').leftJoin('departments as d', 'd.id', 'e.department_id').leftJoin('grades as g', 'g.id', 'e.grade_id').selectAll('i').select(['e.employee_no', 'e.full_name_en', 'd.name as department', 'g.code as grade']).where('i.scenario_id', '=', req.params.id);
    if (req.query.attention) b = b.where((eb) => eb.or([eb('i.exceeds_max_by', '>', 0), eb('i.capped', '=', true), eb('i.requires_exception', '=', true)]));
    const total = Number((await b.clearSelect().select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    const rows = await b.orderBy('i.increase', 'desc').limit(req.query.pageSize).offset(offset(req.query)).execute();
    return { data: rows.map((i) => ({ employeeId: i.employee_id, employeeNo: i.employee_no, name: i.full_name_en, department: i.department ?? null, grade: i.grade ?? null, currentSalary: Number(i.current_salary), currentGross: Number(i.current_gross), increasePct: Number(i.increase_pct), proposedSalary: Number(i.proposed_salary), finalSalary: Number(i.final_salary), increase: Number(i.increase), exceedsMaxBy: Number(i.exceeds_max_by), requiresException: i.requires_exception, capped: i.capped, promoted: i.promoted, included: i.included })), meta: pageMeta(req.query, total) };
  });
  r.post('/scenarios/:id/calculate', { preHandler: requirePermission('compensation:propose'), schema: { tags: T, summary: 'Recalculate against current salaries, bands and ratings', params: idParam, response: { 200: scenarioOut } } }, async (req) => { await calculate(req.params.id); return scenarioMap(await getScenario(req.params.id)); });
  r.post('/scenarios/:id/convert', { preHandler: requirePermission('compensation:propose'), schema: { tags: T, summary: 'Turn a scenario into a DRAFT salary review (items pre-filled with the scenario percentages) for approval. Promotions in the scenario must be raised separately.', params: idParam, body: z.object({ reviewName: z.string().min(3).max(120), effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), budgetAmount: z.number().min(0).nullable().optional() }), response: { 200: z.object({ reviewId: z.string() }), 422: errorSchema } } }, async (req) => {
    const p = requireAuth(req);
    const s = await getScenario(req.params.id);
    if (s.status === 'CONVERTED') throw unprocessable('Scenario was already converted to a review');
    if (Number(req.body.effectiveDate.slice(0, 4)) !== s.fiscal_year) throw unprocessable('The effective date must fall in the scenario fiscal year');
    const cfg = configIn.parse(s.config ?? {});
    const filters = (s.filters ?? {}) as { departmentIds?: string[]; siteIds?: string[]; gradeIds?: string[] };
    const reviewId = await createReview(app, req, p, { name: req.body.reviewName, year: s.fiscal_year, effectiveDate: req.body.effectiveDate, defaultPercentage: cfg.flatPct ?? 0, maxPercentage: cfg.maxIncreasePct ?? null, budgetAmount: req.body.budgetAmount ?? cfg.budgetLimit ?? null, eligibilityRules: { ...(cfg.eligibilityRules as EligibilityRules), departmentIds: filters.departmentIds ?? null, siteIds: filters.siteIds ?? null, gradeIds: filters.gradeIds ?? null }, recommendationMethod: 'DEFAULT_PERCENT', defaultCeilingAction: cfg.ceilingAction, notes: `Created from scenario "${s.name}"`, scenarioId: s.id });
    const items = await app.db.selectFrom('compensation_scenario_items').select(['employee_id', 'current_salary', 'final_salary', 'promoted', 'included']).where('scenario_id', '=', s.id).where('included', '=', true).where('promoted', '=', false).execute();
    const pct = new Map(items.map((i) => [i.employee_id, Number(i.current_salary) > 0 ? Math.round(((Number(i.final_salary) - Number(i.current_salary)) / Number(i.current_salary)) * 100000) / 1000 : 0]));
    await populateReview(app, req, p, reviewId, pct);
    await app.db.updateTable('compensation_scenarios').set({ status: 'CONVERTED', review_id: reviewId }).where('id', '=', s.id).execute();
    await app.audit(req, { action: 'compensation.scenario.convert', entityType: 'compensation_scenario', entityId: s.id, newValue: { reviewId } });

    return { reviewId };
  });
  r.delete('/scenarios/:id', { preHandler: requirePermission('compensation:propose'), schema: { tags: T, summary: 'Archive a scenario', params: idParam, response: { 204: z.null() } } }, async (req, reply) => {
    await app.db.updateTable('compensation_scenarios').set({ status: 'ARCHIVED', deleted_at: new Date() }).where('id', '=', req.params.id).execute();
    await app.audit(req, { action: 'compensation.scenario.archive', entityType: 'compensation_scenario', entityId: req.params.id });
    return reply.status(204).send(null);
  });
};
