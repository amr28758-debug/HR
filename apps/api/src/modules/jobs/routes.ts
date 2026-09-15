import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { idParam, errorSchema } from '../../lib/pagination.js';
import { badRequest, notFound } from '../../plugins/errors.js';
import { requireAuth, requirePermission } from '../../plugins/rbac.js';

const ns = z.string().max(300).nullable().optional();
const list = z.array(z.string()).default([]);

/** Job architecture: career levels → grades (salary bands) → job families → functions → titles (designations) → versioned job descriptions. */
export const jobRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  const lvlOut = z.object({ id: z.string(), code: z.string(), name: z.string(), nameAr: z.string().nullable(), rank: z.number(), description: z.string().nullable(), isActive: z.boolean(), employees: z.number() });
  r.get('/career-levels', { preHandler: requirePermission('jobs:read'), schema: { tags: ['jobs'], summary: 'Career levels', response: { 200: z.array(lvlOut) } } }, async () => {
    const rows = await app.db.selectFrom('career_levels as l').selectAll('l').select((eb) => eb.selectFrom('employees as e').select(eb.fn.countAll().as('n')).whereRef('e.career_level_id', '=', 'l.id').where('e.deleted_at', 'is', null).as('employees')).orderBy('l.rank').execute();
    return rows.map((l) => ({ id: l.id, code: l.code, name: l.name, nameAr: l.name_ar, rank: l.rank, description: l.description, isActive: l.is_active, employees: Number(l.employees ?? 0) }));
  });
  r.post('/career-levels', { preHandler: requirePermission('jobs:write'), schema: { tags: ['jobs'], summary: 'Create/update career level', body: z.object({ code: z.string().min(1), name: z.string().min(1), nameAr: ns, rank: z.number().int().min(1), description: ns }), response: { 201: z.object({ id: z.string() }) } } }, async (req, reply) => {
    const b = req.body;
    const row = await app.db.insertInto('career_levels').values({ code: b.code, name: b.name, name_ar: b.nameAr ?? null, rank: b.rank, description: b.description ?? null }).onConflict((oc) => oc.column('code').doUpdateSet({ name: b.name, name_ar: b.nameAr ?? null, rank: b.rank, description: b.description ?? null })).returning('id').executeTakeFirstOrThrow();
    await app.audit(req, { action: 'jobs.career_level.upsert', entityType: 'career_level', entityId: row.id, newValue: b });
    return reply.status(201).send({ id: row.id });
  });

  const gradeOut = z.object({ id: z.string(), code: z.string(), name: z.string(), careerLevelId: z.string().nullable(), careerLevel: z.string().nullable(), minSalary: z.number().nullable(), midSalary: z.number().nullable(), maxSalary: z.number().nullable(), currency: z.string(), sortOrder: z.number(), isActive: z.boolean(), employees: z.number(), avgBasic: z.number().nullable() });
  r.get('/grades', { preHandler: requirePermission('jobs:read'), schema: { tags: ['jobs'], summary: 'Grades with salary bands and occupancy', response: { 200: z.array(gradeOut) } } }, async () => {
    const rows = await app.db.selectFrom('grades as g').leftJoin('career_levels as l', 'l.id', 'g.career_level_id').selectAll('g').select('l.code as level_code')
      .select((eb) => eb.selectFrom('employees as e').select(eb.fn.countAll().as('n')).whereRef('e.grade_id', '=', 'g.id').where('e.deleted_at', 'is', null).as('employees'))
      .select((eb) => eb.selectFrom('employees as e').innerJoin('employee_salary_structures as s', 's.employee_id', 'e.id').select((eb2) => eb2.fn.avg('s.basic_salary').as('a')).whereRef('e.grade_id', '=', 'g.id').where('s.effective_to', 'is', null).as('avg_basic')).orderBy('g.sort_order').execute();
    return rows.map((g) => ({ id: g.id, code: g.code, name: g.name, careerLevelId: g.career_level_id, careerLevel: g.level_code ?? null, minSalary: g.min_salary, midSalary: g.mid_salary, maxSalary: g.max_salary, currency: g.currency, sortOrder: g.sort_order, isActive: g.is_active, employees: Number(g.employees ?? 0), avgBasic: g.avg_basic === null || g.avg_basic === undefined ? null : Math.round(Number(g.avg_basic)) }));
  });
  r.post('/grades', { preHandler: requirePermission('jobs:write'), schema: { tags: ['jobs'], summary: 'Create/update grade (salary band is company policy — REQUIRES HR CONFIRMATION)', body: z.object({ code: z.string().min(1), name: z.string().min(1), careerLevelId: z.string().uuid().nullable().optional(), minSalary: z.number().nullable().optional(), midSalary: z.number().nullable().optional(), maxSalary: z.number().nullable().optional(), sortOrder: z.number().int().default(100) }), response: { 201: z.object({ id: z.string() }) } } }, async (req, reply) => {
    const b = req.body;
    if (b.minSalary != null && b.maxSalary != null && b.minSalary > b.maxSalary) throw badRequest('minSalary must be <= maxSalary');
    const row = await app.db.insertInto('grades').values({ code: b.code, name: b.name, career_level_id: b.careerLevelId ?? null, min_salary: b.minSalary ?? null, mid_salary: b.midSalary ?? null, max_salary: b.maxSalary ?? null, sort_order: b.sortOrder }).onConflict((oc) => oc.column('code').doUpdateSet({ name: b.name, career_level_id: b.careerLevelId ?? null, min_salary: b.minSalary ?? null, mid_salary: b.midSalary ?? null, max_salary: b.maxSalary ?? null, sort_order: b.sortOrder })).returning('id').executeTakeFirstOrThrow();
    await app.audit(req, { action: 'jobs.grade.upsert', entityType: 'grade', entityId: row.id, newValue: b });
    return reply.status(201).send({ id: row.id });
  });

  const famOut = z.object({ id: z.string(), code: z.string(), name: z.string(), nameAr: z.string().nullable(), isActive: z.boolean(), functions: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), employees: z.number() })) });
  r.get('/families', { preHandler: requirePermission('jobs:read', 'org:read'), schema: { tags: ['jobs'], summary: 'Job families with functions', response: { 200: z.array(famOut) } } }, async () => {
    const fams = await app.db.selectFrom('job_families').selectAll().orderBy('name').execute();
    const funcs = await app.db.selectFrom('job_functions as f').selectAll('f').select((eb) => eb.selectFrom('employees as e').select(eb.fn.countAll().as('n')).whereRef('e.job_function_id', '=', 'f.id').where('e.deleted_at', 'is', null).as('employees')).orderBy('f.name').execute();
    return fams.map((f) => ({ id: f.id, code: f.code, name: f.name, nameAr: f.name_ar, isActive: f.is_active, functions: funcs.filter((x) => x.job_family_id === f.id).map((x) => ({ id: x.id, code: x.code, name: x.name, employees: Number(x.employees ?? 0) })) }));
  });
  r.post('/families', { preHandler: requirePermission('jobs:write'), schema: { tags: ['jobs'], summary: 'Create job family', body: z.object({ code: z.string().min(1), name: z.string().min(1), nameAr: ns }), response: { 201: z.object({ id: z.string() }) } } }, async (req, reply) => {
    const row = await app.db.insertInto('job_families').values({ code: req.body.code, name: req.body.name, name_ar: req.body.nameAr ?? null }).onConflict((oc) => oc.column('code').doUpdateSet({ name: req.body.name })).returning('id').executeTakeFirstOrThrow();
    await app.audit(req, { action: 'jobs.family.upsert', entityType: 'job_family', entityId: row.id, newValue: req.body });
    return reply.status(201).send({ id: row.id });
  });
  r.post('/functions', { preHandler: requirePermission('jobs:write'), schema: { tags: ['jobs'], summary: 'Create job function', body: z.object({ jobFamilyId: z.string().uuid(), code: z.string().min(1), name: z.string().min(1), nameAr: ns }), response: { 201: z.object({ id: z.string() }) } } }, async (req, reply) => {
    const row = await app.db.insertInto('job_functions').values({ job_family_id: req.body.jobFamilyId, code: req.body.code, name: req.body.name, name_ar: req.body.nameAr ?? null }).onConflict((oc) => oc.column('code').doUpdateSet({ name: req.body.name })).returning('id').executeTakeFirstOrThrow();
    await app.audit(req, { action: 'jobs.function.upsert', entityType: 'job_function', entityId: row.id, newValue: req.body });
    return reply.status(201).send({ id: row.id });
  });

  // Titles (designations) enriched with architecture
  r.patch('/titles/:id', { preHandler: requirePermission('jobs:write'), schema: { tags: ['jobs'], summary: 'Link a job title (designation) to family/function/grade/level', params: idParam, body: z.object({ jobFamilyId: z.string().uuid().nullable().optional(), jobFunctionId: z.string().uuid().nullable().optional(), defaultGradeId: z.string().uuid().nullable().optional(), careerLevelId: z.string().uuid().nullable().optional() }), response: { 200: z.object({ ok: z.boolean() }) } } }, async (req) => {
    const b = req.body;
    const res = await app.db.updateTable('designations').set({ ...(b.jobFamilyId !== undefined && { job_family_id: b.jobFamilyId }), ...(b.jobFunctionId !== undefined && { job_function_id: b.jobFunctionId }), ...(b.defaultGradeId !== undefined && { default_grade_id: b.defaultGradeId }), ...(b.careerLevelId !== undefined && { career_level_id: b.careerLevelId }) }).where('id', '=', req.params.id).returning('id').executeTakeFirst();
    if (!res) throw notFound('Designation', req.params.id);
    await app.audit(req, { action: 'jobs.title.link', entityType: 'designation', entityId: req.params.id, newValue: b });
    return { ok: true };
  });

  // Job descriptions
  const jdOut = z.object({ id: z.string(), code: z.string(), title: z.string(), designationId: z.string(), department: z.string().nullable(), jobFamily: z.string().nullable(), jobFunction: z.string().nullable(), grade: z.string().nullable(), careerLevel: z.string().nullable(), reportsTo: z.string().nullable(), location: z.string().nullable(), status: z.string(), currentVersion: z.number(), employees: z.number(), updatedAt: z.string() });
  const jdQuery = () => app.db.selectFrom('job_descriptions as j').innerJoin('designations as d', 'd.id', 'j.designation_id').leftJoin('departments as dep', 'dep.id', 'j.department_id').leftJoin('job_families as f', 'f.id', 'j.job_family_id').leftJoin('job_functions as fn', 'fn.id', 'j.job_function_id').leftJoin('grades as g', 'g.id', 'j.grade_id').leftJoin('career_levels as l', 'l.id', 'j.career_level_id').leftJoin('designations as rt', 'rt.id', 'j.reports_to_designation_id')
    .selectAll('j').select(['d.title', 'dep.name as department', 'f.name as family', 'fn.name as func', 'g.code as grade', 'l.name as level', 'rt.title as reports_to'])
    .select((eb) => eb.selectFrom('employees as e').select(eb.fn.countAll().as('n')).whereRef('e.designation_id', '=', 'j.designation_id').where('e.deleted_at', 'is', null).as('employees'));
  const jdMap = (j: any) => ({ id: j.id, code: j.code, title: j.title, designationId: j.designation_id, department: j.department ?? null, jobFamily: j.family ?? null, jobFunction: j.func ?? null, grade: j.grade ?? null, careerLevel: j.level ?? null, reportsTo: j.reports_to ?? null, location: j.location, status: j.status, currentVersion: j.current_version, employees: Number(j.employees ?? 0), updatedAt: new Date(j.updated_at).toISOString() });
  const verOut = z.object({ id: z.string(), version: z.number(), effectiveFrom: z.string(), status: z.string(), purpose: z.string().nullable(), responsibilities: z.array(z.string()), duties: z.array(z.string()), qualifications: z.array(z.string()), experience: z.string().nullable(), skills: z.array(z.string()), technicalCompetencies: z.array(z.string()), behaviouralCompetencies: z.array(z.string()), kpis: z.array(z.string()), requiredCertifications: z.array(z.string()), approvedAt: z.string().nullable(), createdAt: z.string() });
  const verMap = (v: any) => ({ id: v.id, version: v.version, effectiveFrom: v.effective_from, status: v.status, purpose: v.purpose, responsibilities: v.responsibilities ?? [], duties: v.duties ?? [], qualifications: v.qualifications ?? [], experience: v.experience, skills: v.skills ?? [], technicalCompetencies: v.technical_competencies ?? [], behaviouralCompetencies: v.behavioural_competencies ?? [], kpis: v.kpis ?? [], requiredCertifications: v.required_certifications ?? [], approvedAt: v.approved_at ? new Date(v.approved_at).toISOString() : null, createdAt: new Date(v.created_at).toISOString() });
  r.get('/descriptions', { preHandler: requirePermission('jobs:read'), schema: { tags: ['jobs'], summary: 'Job descriptions', response: { 200: z.array(jdOut) } } }, async () => (await jdQuery().orderBy('d.title').execute()).map(jdMap));
  r.get('/descriptions/:id', { preHandler: requirePermission('jobs:read'), schema: { tags: ['jobs'], summary: 'Job description with versions', params: idParam, response: { 200: jdOut.extend({ versions: z.array(verOut) }), 404: errorSchema } } }, async (req) => {
    const j = await jdQuery().where('j.id', '=', req.params.id).executeTakeFirst();
    if (!j) throw notFound('Job description', req.params.id);
    const versions = await app.db.selectFrom('job_description_versions').selectAll().where('job_description_id', '=', j.id).orderBy('version', 'desc').execute();
    return { ...jdMap(j), versions: versions.map(verMap) };
  });
  const verIn = z.object({ effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), purpose: ns, responsibilities: list, duties: list, qualifications: list, experience: ns, skills: list, technicalCompetencies: list, behaviouralCompetencies: list, kpis: list, requiredCertifications: list });
  r.post('/descriptions', { preHandler: requirePermission('jobs:write'), schema: { tags: ['jobs'], summary: 'Create a job description with its first draft version', body: z.object({ code: z.string().min(1), designationId: z.string().uuid(), departmentId: z.string().uuid().nullable().optional(), jobFamilyId: z.string().uuid().nullable().optional(), jobFunctionId: z.string().uuid().nullable().optional(), gradeId: z.string().uuid().nullable().optional(), careerLevelId: z.string().uuid().nullable().optional(), reportsToDesignationId: z.string().uuid().nullable().optional(), location: ns }).merge(verIn), response: { 201: z.object({ id: z.string(), versionId: z.string() }) } } }, async (req, reply) => {
    const p = requireAuth(req); const b = req.body;
    const res = await app.db.transaction().execute(async (trx) => {
      const jd = await trx.insertInto('job_descriptions').values({ code: b.code, designation_id: b.designationId, department_id: b.departmentId ?? null, job_family_id: b.jobFamilyId ?? null, job_function_id: b.jobFunctionId ?? null, grade_id: b.gradeId ?? null, career_level_id: b.careerLevelId ?? null, reports_to_designation_id: b.reportsToDesignationId ?? null, location: b.location ?? null, created_by: p.userId }).returning('id').executeTakeFirstOrThrow();
      const v = await trx.insertInto('job_description_versions').values({ job_description_id: jd.id, version: 1, effective_from: b.effectiveFrom, purpose: b.purpose ?? null, responsibilities: JSON.stringify(b.responsibilities), duties: JSON.stringify(b.duties), qualifications: JSON.stringify(b.qualifications), experience: b.experience ?? null, skills: JSON.stringify(b.skills), technical_competencies: JSON.stringify(b.technicalCompetencies), behavioural_competencies: JSON.stringify(b.behaviouralCompetencies), kpis: JSON.stringify(b.kpis), required_certifications: JSON.stringify(b.requiredCertifications), created_by: p.userId }).returning('id').executeTakeFirstOrThrow();
      return { id: jd.id, versionId: v.id };
    });
    await app.audit(req, { action: 'jobs.description.create', entityType: 'job_description', entityId: res.id, newValue: b });
    return reply.status(201).send(res);
  });
  r.post('/descriptions/:id/versions', { preHandler: requirePermission('jobs:write'), schema: { tags: ['jobs'], summary: 'Add a new draft version', params: idParam, body: verIn, response: { 201: z.object({ id: z.string(), version: z.number() }) } } }, async (req, reply) => {
    const p = requireAuth(req); const b = req.body;
    const last = await app.db.selectFrom('job_description_versions').select('version').where('job_description_id', '=', req.params.id).orderBy('version', 'desc').executeTakeFirst();
    const v = await app.db.insertInto('job_description_versions').values({ job_description_id: req.params.id, version: (last?.version ?? 0) + 1, effective_from: b.effectiveFrom, purpose: b.purpose ?? null, responsibilities: JSON.stringify(b.responsibilities), duties: JSON.stringify(b.duties), qualifications: JSON.stringify(b.qualifications), experience: b.experience ?? null, skills: JSON.stringify(b.skills), technical_competencies: JSON.stringify(b.technicalCompetencies), behavioural_competencies: JSON.stringify(b.behaviouralCompetencies), kpis: JSON.stringify(b.kpis), required_certifications: JSON.stringify(b.requiredCertifications), created_by: p.userId }).returning(['id', 'version']).executeTakeFirstOrThrow();
    await app.audit(req, { action: 'jobs.description.version', entityType: 'job_description', entityId: req.params.id, newValue: { version: v.version } });
    return reply.status(201).send(v);
  });
  r.post('/descriptions/:id/versions/:vid/approve', { preHandler: requirePermission('jobs:write'), schema: { tags: ['jobs'], summary: 'Approve a version (previous approved version becomes SUPERSEDED)', params: idParam.extend({ vid: z.string().uuid() }), response: { 200: z.object({ ok: z.boolean() }) } } }, async (req) => {
    const p = requireAuth(req);
    await app.db.transaction().execute(async (trx) => {
      const v = await trx.selectFrom('job_description_versions').select(['version']).where('id', '=', req.params.vid).where('job_description_id', '=', req.params.id).executeTakeFirst();
      if (!v) throw notFound('Version', req.params.vid);
      await trx.updateTable('job_description_versions').set({ status: 'SUPERSEDED' }).where('job_description_id', '=', req.params.id).where('status', '=', 'APPROVED').execute();
      await trx.updateTable('job_description_versions').set({ status: 'APPROVED', approved_by: p.userId, approved_at: new Date() }).where('id', '=', req.params.vid).execute();
      await trx.updateTable('job_descriptions').set({ status: 'APPROVED', current_version: v.version }).where('id', '=', req.params.id).execute();
    });
    await app.audit(req, { action: 'jobs.description.approve', entityType: 'job_description', entityId: req.params.id, newValue: { versionId: req.params.vid } });
    return { ok: true };
  });
  r.post('/descriptions/:id/link-employees', { preHandler: requirePermission('jobs:write'), schema: { tags: ['jobs'], summary: 'Link all employees holding this title to the approved version', params: idParam, response: { 200: z.object({ linked: z.number() }) } } }, async (req) => {
    const jd = await app.db.selectFrom('job_descriptions').select(['designation_id', 'current_version']).where('id', '=', req.params.id).executeTakeFirst();
    if (!jd || !jd.current_version) throw badRequest('No approved version to link');
    const v = await app.db.selectFrom('job_description_versions').select('id').where('job_description_id', '=', req.params.id).where('version', '=', jd.current_version).executeTakeFirstOrThrow();
    const res = await app.db.updateTable('employees').set({ job_description_version_id: v.id }).where('designation_id', '=', jd.designation_id).where('deleted_at', 'is', null).returning('id').execute();
    await app.audit(req, { action: 'jobs.description.link_employees', entityType: 'job_description', entityId: req.params.id, metadata: { linked: res.length } });
    return { linked: res.length };
  });

  // Lookups (configuration center)
  const lkOut = z.object({ id: z.string(), category: z.string(), code: z.string(), name: z.string(), nameAr: z.string().nullable(), config: z.unknown(), sortOrder: z.number(), isActive: z.boolean() });
  r.get('/lookups', { preHandler: requirePermission('jobs:read', 'employees:read:own'), schema: { tags: ['jobs'], summary: 'Configurable code lists', querystring: z.object({ category: z.string().optional() }), response: { 200: z.array(lkOut) } } }, async (req) => {
    let q = app.db.selectFrom('lookups').selectAll().where('is_active', '=', true);
    if (req.query.category) q = q.where('category', '=', req.query.category);
    return (await q.orderBy('category').orderBy('sort_order').execute()).map((l) => ({ id: l.id, category: l.category, code: l.code, name: l.name, nameAr: l.name_ar, config: l.config, sortOrder: l.sort_order, isActive: l.is_active }));
  });
  r.post('/lookups', { preHandler: requirePermission('config:write'), schema: { tags: ['jobs'], summary: 'Create/update a lookup value', body: z.object({ category: z.string().min(1), code: z.string().min(1), name: z.string().min(1), nameAr: ns, config: z.record(z.unknown()).default({}), sortOrder: z.number().int().default(100), isActive: z.boolean().default(true) }), response: { 201: lkOut } } }, async (req, reply) => {
    const b = req.body;
    const l = await app.db.insertInto('lookups').values({ category: b.category, code: b.code.toUpperCase(), name: b.name, name_ar: b.nameAr ?? null, config: JSON.stringify(b.config), sort_order: b.sortOrder, is_active: b.isActive }).onConflict((oc) => oc.columns(['category', 'code']).doUpdateSet({ name: b.name, name_ar: b.nameAr ?? null, config: JSON.stringify(b.config), sort_order: b.sortOrder, is_active: b.isActive })).returningAll().executeTakeFirstOrThrow();
    await app.audit(req, { action: 'config.lookup.upsert', entityType: 'lookup', entityId: l.id, newValue: b });
    return reply.status(201).send({ id: l.id, category: l.category, code: l.code, name: l.name, nameAr: l.name_ar, config: l.config, sortOrder: l.sort_order, isActive: l.is_active });
  });
};
