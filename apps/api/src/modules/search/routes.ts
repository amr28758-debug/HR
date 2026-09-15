import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { hasPermission, requireAuth, resolveScope } from '../../plugins/rbac.js';
import { teamEmployeeIds } from '../employees/service.js';

const hit = z.object({ type: z.string(), id: z.string(), title: z.string(), subtitle: z.string().nullable(), link: z.string() });

/** Global search: employee number / name / mobile / matrix id, departments, sites, projects, documents, requests, payroll runs. Scoped by permissions. */
export const searchRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get('/', { schema: { tags: ['search'], summary: 'Global search', querystring: z.object({ q: z.string().min(1).max(100), limit: z.coerce.number().int().min(1).max(50).default(15) }), response: { 200: z.array(hit) } } }, async (req) => {
    const p = requireAuth(req);
    const q = req.query.q.trim();
    const like = `%${q}%`;
    const out: z.infer<typeof hit>[] = [];
    const scope = resolveScope(p, 'employees');
    if (scope !== 'none') {
      let eq = app.db.selectFrom('employees').select(['id', 'employee_no', 'full_name_en', 'status']).where('deleted_at', 'is', null)
        .where((eb) => eb.or([eb('employee_no', 'ilike', like), eb('full_name_en', 'ilike', like), eb('full_name_ar', 'ilike', like), eb('mobile', 'ilike', like), eb('matrix_user_id', '=', q), sql<boolean>`search_vector @@ plainto_tsquery('simple', ${q})`]));
      if (scope === 'own') eq = eq.where('id', '=', p.employeeId ?? '00000000-0000-0000-0000-000000000000');
      if (scope === 'team') eq = eq.where('id', 'in', [...(await teamEmployeeIds(app.db, p)), p.employeeId ?? '00000000-0000-0000-0000-000000000000']);
      const exact = q.toUpperCase();
      for (const e of await eq.orderBy(sql`CASE WHEN upper(employee_no) = ${exact} THEN 0 ELSE 1 END`).orderBy('employee_no').limit(req.query.limit).execute()) out.push({ type: 'employee', id: e.id, title: `${e.employee_no} · ${e.full_name_en}`, subtitle: e.status, link: `/employees/${e.id}` });
    }
    if (hasPermission(p, 'org:read')) {
      for (const d of await app.db.selectFrom('departments').select(['id', 'code', 'name']).where('deleted_at', 'is', null).where((eb) => eb.or([eb('code', 'ilike', like), eb('name', 'ilike', like)])).limit(5).execute()) out.push({ type: 'department', id: d.id, title: d.name, subtitle: d.code, link: `/organization/departments/${d.id}` });
      for (const s of await app.db.selectFrom('sites').select(['id', 'code', 'name']).where('deleted_at', 'is', null).where((eb) => eb.or([eb('code', 'ilike', like), eb('name', 'ilike', like)])).limit(5).execute()) out.push({ type: 'site', id: s.id, title: s.name, subtitle: s.code, link: `/organization/sites/${s.id}` });
      for (const pr of await app.db.selectFrom('projects').select(['id', 'code', 'name']).where('deleted_at', 'is', null).where((eb) => eb.or([eb('code', 'ilike', like), eb('name', 'ilike', like)])).limit(5).execute()) out.push({ type: 'project', id: pr.id, title: `${pr.code} · ${pr.name}`, subtitle: null, link: `/organization/projects/${pr.id}` });
    }
    if (hasPermission(p, 'employees:documents:read')) {
      for (const d of await app.db.selectFrom('employee_documents as d').innerJoin('employees as e', 'e.id', 'd.employee_id').select(['d.id', 'd.document_type', 'd.document_number', 'e.employee_no', 'e.id as eid']).where('d.deleted_at', 'is', null).where('d.document_number', 'ilike', like).limit(5).execute()) out.push({ type: 'document', id: d.id, title: `${d.document_type} ···${String(d.document_number).slice(-4)}`, subtitle: d.employee_no, link: `/employees/${d.eid}?tab=documents` });
    }
    if (hasPermission(p, 'payroll:read')) {
      for (const run of await app.db.selectFrom('payroll_runs').select(['id', 'code', 'status']).where('code', 'ilike', like).limit(3).execute()) out.push({ type: 'payroll', id: run.id, title: run.code, subtitle: run.status, link: `/payroll/runs/${run.id}` });
    }
    if (hasPermission(p, 'devices:read')) {
      for (const d of await app.db.selectFrom('devices').select(['id', 'device_code', 'name']).where('deleted_at', 'is', null).where((eb) => eb.or([eb('device_code', 'ilike', like), eb('name', 'ilike', like)])).limit(3).execute()) out.push({ type: 'device', id: d.id, title: d.name, subtitle: d.device_code, link: `/devices` });
    }
    return out.slice(0, req.query.limit);
  });
};
