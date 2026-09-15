import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { idParam, errorSchema } from '../../lib/pagination.js';
import { badRequest, forbidden, notFound } from '../../plugins/errors.js';
import { hasPermission, requireAuth, requirePermission } from '../../plugins/rbac.js';
import { assertCanSeeEmployee, teamEmployeeIds } from '../employees/service.js';
import { addTimeline } from '../hr-requests/timeline.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ns = z.string().nullable().optional();

/** People development: performance cycles/reviews, training catalog/records, disciplinary cases, HR notes. */
export const peopleRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── Performance ──
  const cycleOut = z.object({ id: z.string(), name: z.string(), year: z.number(), periodStart: z.string(), periodEnd: z.string(), reviewDue: z.string().nullable(), status: z.string(), ratingScale: z.array(z.object({ value: z.number(), label: z.string() })), competencies: z.array(z.string()), reviews: z.number(), finalized: z.number(), avgRating: z.number().nullable() });
  r.get('/performance/cycles', { preHandler: requirePermission('performance:read', 'performance:read:team', 'performance:read:own'), schema: { tags: ['people'], summary: 'Performance cycles', response: { 200: z.array(cycleOut) } } }, async () => {
    const rows = await app.db.selectFrom('performance_cycles as c').selectAll('c').select((eb) => eb.selectFrom('performance_reviews as r').select(eb.fn.countAll().as('n')).whereRef('r.cycle_id', '=', 'c.id').as('reviews')).select((eb) => eb.selectFrom('performance_reviews as r').select(eb.fn.countAll().as('n')).whereRef('r.cycle_id', '=', 'c.id').where('r.status', '=', 'FINAL').as('finalized')).select((eb) => eb.selectFrom('performance_reviews as r').select((eb2) => eb2.fn.avg('r.final_rating').as('a')).whereRef('r.cycle_id', '=', 'c.id').as('avg')).orderBy('c.cycle_year', 'desc').execute();
    return rows.map((c) => ({ id: c.id, name: c.name, year: c.cycle_year, periodStart: c.period_start, periodEnd: c.period_end, reviewDue: c.review_due, status: c.status, ratingScale: c.rating_scale as any, competencies: c.competencies as string[], reviews: Number(c.reviews ?? 0), finalized: Number(c.finalized ?? 0), avgRating: c.avg == null ? null : Math.round(Number(c.avg) * 100) / 100 }));
  });
  r.post('/performance/cycles', { preHandler: requirePermission('performance:write'), schema: { tags: ['people'], summary: 'Create performance cycle', body: z.object({ name: z.string().min(1), year: z.number().int(), periodStart: isoDate, periodEnd: isoDate, reviewDue: isoDate.optional(), competencies: z.array(z.string()).optional(), ratingScale: z.array(z.object({ value: z.number(), label: z.string() })).optional() }), response: { 201: z.object({ id: z.string() }) } } }, async (req, reply) => {
    const b = req.body;
    const c = await app.db.insertInto('performance_cycles').values({ name: b.name, cycle_year: b.year, period_start: b.periodStart, period_end: b.periodEnd, review_due: b.reviewDue ?? null, status: 'OPEN', ...(b.competencies && { competencies: JSON.stringify(b.competencies) }), ...(b.ratingScale && { rating_scale: JSON.stringify(b.ratingScale) }), created_by: req.principal!.userId }).returning('id').executeTakeFirstOrThrow();
    await app.audit(req, { action: 'performance.cycle.create', entityType: 'performance_cycle', entityId: c.id, newValue: b });
    return reply.status(201).send({ id: c.id });
  });
  r.post('/performance/cycles/:id/launch', { preHandler: requirePermission('performance:write'), schema: { tags: ['people'], summary: 'Create draft reviews for all working employees (or a filter) with their manager as reviewer', params: idParam, body: z.object({ siteId: z.string().uuid().optional(), departmentId: z.string().uuid().optional(), employeeIds: z.array(z.string().uuid()).optional() }), response: { 200: z.object({ created: z.number() }) } } }, async (req) => {
    let q = app.db.selectFrom('employees').select(['id', 'manager_employee_id']).where('deleted_at', 'is', null).where('status', 'in', ['ACTIVE', 'PROBATION', 'CONFIRMED', 'TRANSFERRED', 'PROMOTED']);
    if (req.body.siteId) q = q.where('site_id', '=', req.body.siteId);
    if (req.body.departmentId) q = q.where('department_id', '=', req.body.departmentId);
    if (req.body.employeeIds?.length) q = q.where('id', 'in', req.body.employeeIds);
    let created = 0;
    for (const e of await q.execute()) {
      const res = await app.db.insertInto('performance_reviews').values({ cycle_id: req.params.id, employee_id: e.id, reviewer_employee_id: e.manager_employee_id }).onConflict((oc) => oc.doNothing()).returning('id').executeTakeFirst();
      if (res) created++;
    }
    await app.audit(req, { action: 'performance.cycle.launch', entityType: 'performance_cycle', entityId: req.params.id, metadata: { created } });
    return { created };
  });
  const reviewOut = z.object({ id: z.string(), cycleId: z.string(), cycleName: z.string(), employeeId: z.string(), employeeNo: z.string(), employeeName: z.string(), reviewer: z.string().nullable(), status: z.string(), selfRating: z.number().nullable(), managerRating: z.number().nullable(), finalRating: z.number().nullable(), competencyScores: z.record(z.number()), selfComments: z.string().nullable(), managerComments: z.string().nullable(), developmentPlan: z.string().nullable(), finalizedAt: z.string().nullable(), goals: z.array(z.object({ id: z.string(), title: z.string(), kpi: z.string().nullable(), weight: z.number(), target: z.string().nullable(), achievement: z.string().nullable(), score: z.number().nullable() })) });
  const reviewQuery = () => app.db.selectFrom('performance_reviews as r').innerJoin('performance_cycles as c', 'c.id', 'r.cycle_id').innerJoin('employees as e', 'e.id', 'r.employee_id').leftJoin('employees as m', 'm.id', 'r.reviewer_employee_id').selectAll('r').select(['c.name as cycle_name', 'e.employee_no', 'e.full_name_en', 'm.full_name_en as reviewer']);
  const reviewMap = async (x: any) => ({ id: x.id, cycleId: x.cycle_id, cycleName: x.cycle_name, employeeId: x.employee_id, employeeNo: x.employee_no, employeeName: x.full_name_en, reviewer: x.reviewer ?? null, status: x.status, selfRating: x.self_rating, managerRating: x.manager_rating, finalRating: x.final_rating, competencyScores: (x.competency_scores ?? {}) as Record<string, number>, selfComments: x.self_comments, managerComments: x.manager_comments, developmentPlan: x.development_plan, finalizedAt: x.finalized_at ? new Date(x.finalized_at).toISOString() : null, goals: (await app.db.selectFrom('performance_goals').selectAll().where('review_id', '=', x.id).orderBy('sort_order').execute()).map((g) => ({ id: g.id, title: g.title, kpi: g.kpi, weight: Number(g.weight), target: g.target, achievement: g.achievement, score: g.score })) });
  r.get('/performance/reviews', { preHandler: requirePermission('performance:read', 'performance:read:team', 'performance:read:own'), schema: { tags: ['people'], summary: 'Reviews (scoped)', querystring: z.object({ cycleId: z.string().uuid().optional(), employeeId: z.string().uuid().optional(), status: z.string().optional() }), response: { 200: z.array(reviewOut) } } }, async (req) => {
    const p = requireAuth(req);
    let q = reviewQuery();
    if (!hasPermission(p, 'performance:read')) q = q.where('r.employee_id', 'in', hasPermission(p, 'performance:read:team') ? [...(await teamEmployeeIds(app.db, p)), p.employeeId ?? '00000000-0000-0000-0000-000000000000'] : [p.employeeId ?? '00000000-0000-0000-0000-000000000000']);
    if (req.query.cycleId) q = q.where('r.cycle_id', '=', req.query.cycleId);
    if (req.query.employeeId) q = q.where('r.employee_id', '=', req.query.employeeId);
    if (req.query.status) q = q.where('r.status', '=', req.query.status);
    return Promise.all((await q.orderBy('e.employee_no').limit(500).execute()).map(reviewMap));
  });
  r.patch('/performance/reviews/:id', { preHandler: requirePermission('performance:write', 'performance:read:own'), schema: { tags: ['people'], summary: 'Update a review (self section by the employee, manager section by reviewer/HR, final by HR)', params: idParam, body: z.object({ selfRating: z.number().min(0).max(5).optional(), selfComments: ns, managerRating: z.number().min(0).max(5).optional(), managerComments: ns, competencyScores: z.record(z.number().min(0).max(5)).optional(), developmentPlan: ns, goals: z.array(z.object({ title: z.string().min(1), kpi: ns, weight: z.number().min(0).max(100).default(0), target: ns, achievement: ns, score: z.number().min(0).max(5).nullable().optional() })).optional(), finalize: z.boolean().optional(), finalRating: z.number().min(0).max(5).optional() }), response: { 200: reviewOut, 403: errorSchema } } }, async (req) => {
    const p = requireAuth(req); const b = req.body;
    const rv = await app.db.selectFrom('performance_reviews').selectAll().where('id', '=', req.params.id).executeTakeFirst();
    if (!rv) throw notFound('Review', req.params.id);
    const isSelf = rv.employee_id === p.employeeId;
    const isReviewer = !!rv.reviewer_employee_id && rv.reviewer_employee_id === p.employeeId;
    const isHr = hasPermission(p, 'performance:write') && hasPermission(p, 'performance:read');
    if (!isSelf && !isReviewer && !isHr) throw forbidden();
    if (rv.status === 'FINAL' && !isHr) throw badRequest('Review is finalized');
    const patch: Record<string, unknown> = {};
    if (isSelf || isHr) { if (b.selfRating !== undefined) patch.self_rating = b.selfRating; if (b.selfComments !== undefined) patch.self_comments = b.selfComments; if (isSelf && !isHr) patch.status = 'SELF_REVIEW'; }
    if (isReviewer || isHr) { if (b.managerRating !== undefined) patch.manager_rating = b.managerRating; if (b.managerComments !== undefined) patch.manager_comments = b.managerComments; if (b.competencyScores) patch.competency_scores = JSON.stringify(b.competencyScores); if (b.developmentPlan !== undefined) patch.development_plan = b.developmentPlan; if (!isHr) patch.status = 'MANAGER_REVIEW'; }
    if (isHr && b.finalize) { patch.status = 'FINAL'; patch.final_rating = b.finalRating ?? b.managerRating ?? rv.manager_rating; patch.finalized_by = p.userId; patch.finalized_at = new Date(); }
    await app.db.transaction().execute(async (trx) => {
      if (Object.keys(patch).length) await trx.updateTable('performance_reviews').set(patch as any).where('id', '=', rv.id).execute();
      if (b.goals && (isReviewer || isHr || isSelf)) { await trx.deleteFrom('performance_goals').where('review_id', '=', rv.id).execute(); for (const [i, g] of b.goals.entries()) await trx.insertInto('performance_goals').values({ review_id: rv.id, title: g.title, kpi: g.kpi ?? null, weight: g.weight, target: g.target ?? null, achievement: g.achievement ?? null, score: g.score ?? null, sort_order: (i + 1) * 10 }).execute(); }
    });
    if (patch.status === 'FINAL') await addTimeline(app.db, { employeeId: rv.employee_id, type: 'PERFORMANCE', title: `Performance review finalized · ${patch.final_rating} / 5`, refType: 'performance_review', refId: rv.id, actorUserId: p.userId, visibility: 'EMPLOYEE' });
    await app.audit(req, { action: 'performance.review.update', entityType: 'performance_review', entityId: rv.id, newValue: patch });
    return reviewMap(await reviewQuery().where('r.id', '=', rv.id).executeTakeFirstOrThrow());
  });

  // ── Training ──
  const catOut = z.object({ id: z.string(), code: z.string(), title: z.string(), category: z.string(), provider: z.string().nullable(), durationHours: z.number().nullable(), validityMonths: z.number().nullable(), isMandatory: z.boolean(), isActive: z.boolean(), completed: z.number(), assigned: z.number() });
  r.get('/training/catalog', { preHandler: requirePermission('training:read', 'training:read:own'), schema: { tags: ['people'], summary: 'Training catalog', response: { 200: z.array(catOut) } } }, async () => {
    const rows = await app.db.selectFrom('training_catalog as t').selectAll('t').select((eb) => eb.selectFrom('training_records as r').select(eb.fn.countAll().as('n')).whereRef('r.training_id', '=', 't.id').where('r.status', '=', 'COMPLETED').as('completed')).select((eb) => eb.selectFrom('training_records as r').select(eb.fn.countAll().as('n')).whereRef('r.training_id', '=', 't.id').where('r.status', 'in', ['ASSIGNED', 'IN_PROGRESS']).as('assigned')).orderBy('t.category').orderBy('t.title').execute();
    return rows.map((t) => ({ id: t.id, code: t.code, title: t.title, category: t.category, provider: t.provider, durationHours: t.duration_hours, validityMonths: t.validity_months, isMandatory: t.is_mandatory, isActive: t.is_active, completed: Number(t.completed ?? 0), assigned: Number(t.assigned ?? 0) }));
  });
  r.post('/training/catalog', { preHandler: requirePermission('training:write'), schema: { tags: ['people'], summary: 'Create/update training course', body: z.object({ code: z.string().min(1), title: z.string().min(1), titleAr: ns, category: z.string().default('GENERAL'), provider: ns, durationHours: z.number().nullable().optional(), validityMonths: z.number().int().nullable().optional(), isMandatory: z.boolean().default(false), description: ns }), response: { 201: z.object({ id: z.string() }) } } }, async (req, reply) => {
    const b = req.body;
    const t = await app.db.insertInto('training_catalog').values({ code: b.code.toUpperCase(), title: b.title, title_ar: b.titleAr ?? null, category: b.category, provider: b.provider ?? null, duration_hours: b.durationHours ?? null, validity_months: b.validityMonths ?? null, is_mandatory: b.isMandatory, description: b.description ?? null }).onConflict((oc) => oc.column('code').doUpdateSet({ title: b.title, category: b.category, provider: b.provider ?? null, duration_hours: b.durationHours ?? null, validity_months: b.validityMonths ?? null, is_mandatory: b.isMandatory })).returning('id').executeTakeFirstOrThrow();
    await app.audit(req, { action: 'training.catalog.upsert', entityType: 'training_catalog', entityId: t.id, newValue: b });
    return reply.status(201).send({ id: t.id });
  });
  const recOut = z.object({ id: z.string(), trainingId: z.string(), code: z.string(), title: z.string(), category: z.string(), employeeId: z.string(), employeeNo: z.string(), employeeName: z.string(), status: z.string(), scheduledDate: z.string().nullable(), completedAt: z.string().nullable(), score: z.number().nullable(), certificateNo: z.string().nullable(), certificateExpiry: z.string().nullable(), expiryStatus: z.string().nullable(), cost: z.number().nullable(), notes: z.string().nullable() });
  const recQuery = () => app.db.selectFrom('training_records as r').innerJoin('training_catalog as t', 't.id', 'r.training_id').innerJoin('employees as e', 'e.id', 'r.employee_id').selectAll('r').select(['t.code', 't.title', 't.category', 'e.employee_no', 'e.full_name_en']);
  const recMap = (x: any) => { const d = x.certificate_expiry ? Math.round((new Date(x.certificate_expiry).getTime() - Date.now()) / 864e5) : null; return { id: x.id, trainingId: x.training_id, code: x.code, title: x.title, category: x.category, employeeId: x.employee_id, employeeNo: x.employee_no, employeeName: x.full_name_en, status: x.status, scheduledDate: x.scheduled_date, completedAt: x.completed_at, score: x.score, certificateNo: x.certificate_no, certificateExpiry: x.certificate_expiry, expiryStatus: d === null ? null : d < 0 ? 'EXPIRED' : d <= 60 ? 'EXPIRING' : 'VALID', cost: x.cost, notes: x.notes }; };
  r.get('/training/records', { preHandler: requirePermission('training:read', 'training:read:own'), schema: { tags: ['people'], summary: 'Training records (scoped)', querystring: z.object({ employeeId: z.string().uuid().optional(), status: z.string().optional(), expiring: z.coerce.boolean().optional() }), response: { 200: z.array(recOut) } } }, async (req) => {
    const p = requireAuth(req);
    let q = recQuery();
    if (!hasPermission(p, 'training:read')) q = q.where('r.employee_id', '=', p.employeeId ?? '00000000-0000-0000-0000-000000000000');
    if (req.query.employeeId) q = q.where('r.employee_id', '=', req.query.employeeId);
    if (req.query.status) q = q.where('r.status', '=', req.query.status);
    if (req.query.expiring) q = q.where('r.certificate_expiry', '<=', sql<string>`current_date + 60`);
    return (await q.orderBy('r.created_at', 'desc').limit(500).execute()).map(recMap);
  });
  r.post('/training/records', { preHandler: requirePermission('training:write'), schema: { tags: ['people'], summary: 'Assign training to an employee', body: z.object({ employeeId: z.string().uuid(), trainingId: z.string().uuid(), scheduledDate: isoDate.optional(), notes: ns }), response: { 201: recOut } } }, async (req, reply) => {
    const p = requireAuth(req);
    const rec = await app.db.insertInto('training_records').values({ employee_id: req.body.employeeId, training_id: req.body.trainingId, scheduled_date: req.body.scheduledDate ?? null, notes: req.body.notes ?? null, assigned_by: p.userId }).returning('id').executeTakeFirstOrThrow();
    const row = await recQuery().where('r.id', '=', rec.id).executeTakeFirstOrThrow();
    await addTimeline(app.db, { employeeId: req.body.employeeId, type: 'TRAINING', title: `Assigned training · ${row.title}`, refType: 'training_record', refId: rec.id, actorUserId: p.userId, visibility: 'EMPLOYEE' });
    await app.audit(req, { action: 'training.assign', entityType: 'training_record', entityId: rec.id, newValue: req.body });
    return reply.status(201).send(recMap(row));
  });
  r.patch('/training/records/:id', { preHandler: requirePermission('training:write'), schema: { tags: ['people'], summary: 'Update training record (complete, score, certificate)', params: idParam, body: z.object({ status: z.enum(['ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED']).optional(), completedAt: isoDate.optional(), score: z.number().nullable().optional(), certificateNo: ns, certificateExpiry: isoDate.nullable().optional(), certificateObjectKey: ns, cost: z.number().nullable().optional(), notes: ns }), response: { 200: recOut } } }, async (req) => {
    const p = requireAuth(req); const b = req.body;
    const before = await recQuery().where('r.id', '=', req.params.id).executeTakeFirst();
    if (!before) throw notFound('Training record', req.params.id);
    let expiry = b.certificateExpiry;
    if (b.status === 'COMPLETED' && expiry === undefined) { const t = await app.db.selectFrom('training_catalog').select('validity_months').where('id', '=', before.training_id).executeTakeFirstOrThrow(); if (t.validity_months) { const d = new Date(b.completedAt ?? new Date().toISOString().slice(0, 10)); d.setMonth(d.getMonth() + t.validity_months); expiry = d.toISOString().slice(0, 10); } }
    await app.db.updateTable('training_records').set({ ...(b.status && { status: b.status }), ...(b.completedAt && { completed_at: b.completedAt }), ...(b.status === 'COMPLETED' && !b.completedAt && { completed_at: new Date().toISOString().slice(0, 10) }), ...(b.score !== undefined && { score: b.score }), ...(b.certificateNo !== undefined && { certificate_no: b.certificateNo }), ...(expiry !== undefined && { certificate_expiry: expiry }), ...(b.certificateObjectKey !== undefined && { certificate_object_key: b.certificateObjectKey }), ...(b.cost !== undefined && { cost: b.cost }), ...(b.notes !== undefined && { notes: b.notes }) }).where('id', '=', req.params.id).execute();
    if (b.status === 'COMPLETED') await addTimeline(app.db, { employeeId: before.employee_id, type: 'TRAINING', title: `Training completed · ${before.title}`, description: expiry ? `Certificate valid until ${expiry}` : null, refType: 'training_record', refId: req.params.id, actorUserId: p.userId, visibility: 'EMPLOYEE' });
    await app.audit(req, { action: 'training.record.update', entityType: 'training_record', entityId: req.params.id, newValue: b });
    return recMap(await recQuery().where('r.id', '=', req.params.id).executeTakeFirstOrThrow());
  });

  // ── Disciplinary (restricted) ──
  const caseOut = z.object({ id: z.string(), caseNo: z.string(), employeeId: z.string(), employeeNo: z.string(), employeeName: z.string(), category: z.string(), severity: z.string(), incidentDate: z.string(), description: z.string(), actionTaken: z.string().nullable(), employeeResponse: z.string().nullable(), status: z.string(), isConfidential: z.boolean(), evidence: z.array(z.unknown()), createdAt: z.string(), closedAt: z.string().nullable() });
  const caseQuery = () => app.db.selectFrom('disciplinary_cases as c').innerJoin('employees as e', 'e.id', 'c.employee_id').selectAll('c').select(['e.employee_no', 'e.full_name_en']);
  const caseMap = (c: any) => ({ id: c.id, caseNo: c.case_no, employeeId: c.employee_id, employeeNo: c.employee_no, employeeName: c.full_name_en, category: c.category, severity: c.severity, incidentDate: c.incident_date, description: c.description, actionTaken: c.action_taken, employeeResponse: c.employee_response, status: c.status, isConfidential: c.is_confidential, evidence: (c.evidence ?? []) as unknown[], createdAt: new Date(c.created_at).toISOString(), closedAt: c.closed_at ? new Date(c.closed_at).toISOString() : null });
  r.get('/disciplinary', { preHandler: requirePermission('disciplinary:read'), schema: { tags: ['people'], summary: 'Disciplinary cases (restricted)', querystring: z.object({ employeeId: z.string().uuid().optional(), status: z.string().optional() }), response: { 200: z.array(caseOut) } } }, async (req) => {
    let q = caseQuery();
    if (req.query.employeeId) q = q.where('c.employee_id', '=', req.query.employeeId);
    if (req.query.status) q = q.where('c.status', '=', req.query.status);
    return (await q.orderBy('c.created_at', 'desc').limit(500).execute()).map(caseMap);
  });
  r.post('/disciplinary', { preHandler: requirePermission('disciplinary:write'), schema: { tags: ['people'], summary: 'Open a disciplinary case', body: z.object({ employeeId: z.string().uuid(), category: z.string(), severity: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('MEDIUM'), incidentDate: isoDate, description: z.string().min(5), evidence: z.array(z.object({ objectKey: z.string(), fileName: z.string() })).default([]), isConfidential: z.boolean().default(true) }), response: { 201: caseOut } } }, async (req, reply) => {
    const p = requireAuth(req); const b = req.body;
    const n = (await sql<{ n: number }>`SELECT nextval('disciplinary_case_no_seq')::int AS n`.execute(app.db)).rows[0]!;
    const c = await app.db.insertInto('disciplinary_cases').values({ case_no: `DC-${new Date().getFullYear()}-${String(n.n).padStart(4, '0')}`, employee_id: b.employeeId, category: b.category, severity: b.severity, incident_date: b.incidentDate, description: b.description, evidence: JSON.stringify(b.evidence), is_confidential: b.isConfidential, created_by: p.userId }).returning('id').executeTakeFirstOrThrow();
    await addTimeline(app.db, { employeeId: b.employeeId, type: 'DISCIPLINARY', title: `Disciplinary case opened · ${b.category.replace(/_/g, ' ').toLowerCase()}`, refType: 'disciplinary_case', refId: c.id, actorUserId: p.userId, visibility: 'RESTRICTED' });
    await app.audit(req, { action: 'disciplinary.case.open', entityType: 'disciplinary_case', entityId: c.id, newValue: { employeeId: b.employeeId, category: b.category, severity: b.severity } });
    return reply.status(201).send(caseMap(await caseQuery().where('c.id', '=', c.id).executeTakeFirstOrThrow()));
  });
  r.patch('/disciplinary/:id', { preHandler: requirePermission('disciplinary:write'), schema: { tags: ['people'], summary: 'Update a case (action, response, status)', params: idParam, body: z.object({ actionTaken: ns, employeeResponse: ns, status: z.enum(['OPEN', 'UNDER_INVESTIGATION', 'ACTION_TAKEN', 'CLOSED', 'WITHDRAWN']).optional(), evidence: z.array(z.object({ objectKey: z.string(), fileName: z.string() })).optional() }), response: { 200: caseOut } } }, async (req) => {
    const p = requireAuth(req); const b = req.body;
    const res = await app.db.updateTable('disciplinary_cases').set({ ...(b.actionTaken !== undefined && { action_taken: b.actionTaken }), ...(b.employeeResponse !== undefined && { employee_response: b.employeeResponse }), ...(b.status && { status: b.status }), ...(b.status === 'CLOSED' && { closed_at: new Date() }), ...(b.evidence && { evidence: JSON.stringify(b.evidence) }) }).where('id', '=', req.params.id).returning(['employee_id', 'case_no']).executeTakeFirst();
    if (!res) throw notFound('Case', req.params.id);
    if (b.status === 'ACTION_TAKEN' || b.status === 'CLOSED') await addTimeline(app.db, { employeeId: res.employee_id, type: 'DISCIPLINARY', title: `Case ${res.case_no} ${b.status === 'CLOSED' ? 'closed' : 'action taken'}`, description: b.actionTaken ?? null, refType: 'disciplinary_case', refId: req.params.id, actorUserId: p.userId, visibility: 'RESTRICTED' });
    await app.audit(req, { action: 'disciplinary.case.update', entityType: 'disciplinary_case', entityId: req.params.id, newValue: b });
    return caseMap(await caseQuery().where('c.id', '=', req.params.id).executeTakeFirstOrThrow());
  });

  // ── Notes ──
  const noteOut = z.object({ id: z.string(), employeeId: z.string(), category: z.string(), note: z.string(), isConfidential: z.boolean(), pinned: z.boolean(), author: z.string().nullable(), createdAt: z.string() });
  r.get('/notes/:employeeId', { preHandler: requirePermission('notes:read'), schema: { tags: ['people'], summary: 'HR notes for an employee (confidential notes need notes:confidential)', params: z.object({ employeeId: z.string().uuid() }), response: { 200: z.array(noteOut) } } }, async (req) => {
    const p = requireAuth(req);
    await assertCanSeeEmployee(app.db, p, 'employees', req.params.employeeId);
    let q = app.db.selectFrom('employee_notes as n').leftJoin('users as u', 'u.id', 'n.created_by').selectAll('n').select('u.display_name').where('n.employee_id', '=', req.params.employeeId);
    if (!hasPermission(p, 'notes:confidential')) q = q.where('n.is_confidential', '=', false);
    return (await q.orderBy('n.pinned', 'desc').orderBy('n.created_at', 'desc').execute()).map((n) => ({ id: n.id, employeeId: n.employee_id, category: n.category, note: n.note, isConfidential: n.is_confidential, pinned: n.pinned, author: n.display_name ?? null, createdAt: new Date(n.created_at).toISOString() }));
  });
  r.post('/notes/:employeeId', { preHandler: requirePermission('notes:write'), schema: { tags: ['people'], summary: 'Add HR note', params: z.object({ employeeId: z.string().uuid() }), body: z.object({ note: z.string().min(1).max(4000), category: z.string().default('GENERAL'), isConfidential: z.boolean().default(false), pinned: z.boolean().default(false) }), response: { 201: noteOut } } }, async (req, reply) => {
    const p = requireAuth(req);
    if (req.body.isConfidential && !hasPermission(p, 'notes:confidential')) throw forbidden('Confidential notes need notes:confidential');
    const n = await app.db.insertInto('employee_notes').values({ employee_id: req.params.employeeId, note: req.body.note, category: req.body.category, is_confidential: req.body.isConfidential, pinned: req.body.pinned, created_by: p.userId }).returningAll().executeTakeFirstOrThrow();
    await app.audit(req, { action: 'notes.create', entityType: 'employee_note', entityId: n.id, metadata: { employeeId: req.params.employeeId, confidential: n.is_confidential } });
    return reply.status(201).send({ id: n.id, employeeId: n.employee_id, category: n.category, note: n.note, isConfidential: n.is_confidential, pinned: n.pinned, author: p.displayName, createdAt: new Date(n.created_at).toISOString() });
  });
};
