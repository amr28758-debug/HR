import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getEnv } from '@burtplace/config';
import { idParam, errorSchema, offset, pageMeta, paginated, paginationQuery } from '../../lib/pagination.js';
import { badRequest, forbidden, notFound } from '../../plugins/errors.js';
import { hasPermission, requireAuth, requirePermission } from '../../plugins/rbac.js';
import { letterDocument, letterVariables, nextLetterNo, renderTemplate, templateVariableNames, verificationCode } from './service.js';
import { addTimeline } from '../hr-requests/timeline.js';

const COMPANY = { name: 'Burtplace General Contracting', nameAr: 'بيرتبليس للمقاولات العامة' };

export const letterRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const env = getEnv();

  const tplOut = z.object({ id: z.string(), code: z.string(), version: z.number(), name: z.string(), nameAr: z.string().nullable(), category: z.string(), language: z.string(), subject: z.string().nullable(), bodyEn: z.string().nullable(), bodyAr: z.string().nullable(), requiresApproval: z.boolean(), signatoryName: z.string().nullable(), signatoryTitle: z.string().nullable(), signatoryTitleAr: z.string().nullable(), isActive: z.boolean(), variables: z.array(z.string()) });
  const tplMap = (t: any) => ({ id: t.id, code: t.code, version: t.version, name: t.name, nameAr: t.name_ar, category: t.category, language: t.language, subject: t.subject, bodyEn: t.body_en, bodyAr: t.body_ar, requiresApproval: t.requires_approval, signatoryName: t.signatory_name, signatoryTitle: t.signatory_title, signatoryTitleAr: t.signatory_title_ar, isActive: t.is_active, variables: templateVariableNames(`${t.body_en ?? ''} ${t.body_ar ?? ''}`) });
  r.get('/templates', { preHandler: requirePermission('letters:generate', 'letters:templates:write', 'requests:create:own'), schema: { tags: ['letters'], summary: 'Letter templates (active versions)', response: { 200: z.array(tplOut) } } }, async () => (await app.db.selectFrom('letter_templates').selectAll().where('is_active', '=', true).orderBy('category').orderBy('name').execute()).map(tplMap));
  r.post('/templates', { preHandler: requirePermission('letters:templates:write'), schema: { tags: ['letters'], summary: 'Create a new template version (previous version deactivated)', body: z.object({ code: z.string().min(1), name: z.string().min(1), nameAr: z.string().nullable().optional(), category: z.string().default('CERTIFICATE'), language: z.enum(['en', 'ar', 'bilingual']).default('en'), subject: z.string().nullable().optional(), bodyEn: z.string().nullable().optional(), bodyAr: z.string().nullable().optional(), requiresApproval: z.boolean().default(false), signatoryName: z.string().nullable().optional(), signatoryTitle: z.string().nullable().optional(), signatoryTitleAr: z.string().nullable().optional() }), response: { 201: tplOut } } }, async (req, reply) => {
    const p = requireAuth(req); const b = req.body;
    if (!b.bodyEn && !b.bodyAr) throw badRequest('bodyEn or bodyAr is required');
    const t = await app.db.transaction().execute(async (trx) => {
      const prev = await trx.selectFrom('letter_templates').select('version').where('code', '=', b.code).orderBy('version', 'desc').executeTakeFirst();
      await trx.updateTable('letter_templates').set({ is_active: false }).where('code', '=', b.code).execute();
      return trx.insertInto('letter_templates').values({ code: b.code.toUpperCase(), version: (prev?.version ?? 0) + 1, name: b.name, name_ar: b.nameAr ?? null, category: b.category, language: b.language, subject: b.subject ?? null, body_en: b.bodyEn ?? null, body_ar: b.bodyAr ?? null, requires_approval: b.requiresApproval, signatory_name: b.signatoryName ?? null, signatory_title: b.signatoryTitle ?? null, signatory_title_ar: b.signatoryTitleAr ?? null, created_by: p.userId }).returningAll().executeTakeFirstOrThrow();
    });
    await app.audit(req, { action: 'letters.template.create', entityType: 'letter_template', entityId: t.id, newValue: { code: b.code, version: t.version } });
    return reply.status(201).send(tplMap(t));
  });
  r.post('/templates/:id/preview', { preHandler: requirePermission('letters:generate', 'letters:templates:write'), schema: { tags: ['letters'], summary: 'Render a template for an employee without issuing it', params: idParam, body: z.object({ employeeId: z.string().uuid(), addressee: z.string().optional(), purpose: z.string().optional(), language: z.enum(['en', 'ar', 'bilingual']).optional() }), response: { 200: z.object({ html: z.string(), variables: z.record(z.unknown()) }) } } }, async (req) => {
    const t = await app.db.selectFrom('letter_templates').selectAll().where('id', '=', req.params.id).executeTakeFirst();
    if (!t) throw notFound('Template', req.params.id);
    const vars = await letterVariables(app.db, req.body.employeeId, { addressee: req.body.addressee, purpose: req.body.purpose, company: COMPANY });
    const lang = req.body.language ?? t.language;
    const html = letterDocument({ htmlEn: lang !== 'ar' && t.body_en ? renderTemplate(t.body_en, vars) : null, htmlAr: lang !== 'en' && t.body_ar ? renderTemplate(t.body_ar, vars) : null, letterNo: 'PREVIEW', verificationCode: 'PREVIEW', verifyUrl: `${env.WEB_PUBLIC_URL}/verify`, company: COMPANY, signatoryName: t.signatory_name, signatoryTitle: t.signatory_title, signatoryTitleAr: t.signatory_title_ar });
    return { html, variables: vars };
  });

  const letterOut = z.object({ id: z.string(), letterNo: z.string(), verificationCode: z.string(), templateCode: z.string(), templateName: z.string(), employeeId: z.string(), employeeNo: z.string(), employeeName: z.string(), language: z.string(), addressee: z.string().nullable(), purpose: z.string().nullable(), status: z.string(), issuedAt: z.string().nullable(), issuedBy: z.string().nullable(), createdAt: z.string() });
  const letterQuery = () => app.db.selectFrom('generated_letters as g').innerJoin('letter_templates as t', 't.id', 'g.template_id').innerJoin('employees as e', 'e.id', 'g.employee_id').leftJoin('users as u', 'u.id', 'g.issued_by').selectAll('g').select(['t.code as tcode', 't.name as tname', 'e.employee_no', 'e.full_name_en', 'u.display_name']);
  const letterMap = (g: any) => ({ id: g.id, letterNo: g.letter_no, verificationCode: g.verification_code, templateCode: g.tcode, templateName: g.tname, employeeId: g.employee_id, employeeNo: g.employee_no, employeeName: g.full_name_en, language: g.language, addressee: g.addressee, purpose: g.purpose, status: g.status, issuedAt: g.issued_at ? new Date(g.issued_at).toISOString() : null, issuedBy: g.display_name ?? null, createdAt: new Date(g.created_at).toISOString() });

  /** Issue a letter directly (HR). Templates that require approval must go through POST /employees/:id/generate-letter (creates an HR request). */
  r.post('/generate', { preHandler: requirePermission('letters:generate'), schema: { tags: ['letters'], summary: 'Generate and issue a letter for an employee (audited; stored on the profile)', body: z.object({ employeeId: z.string().uuid(), templateCode: z.string(), language: z.enum(['en', 'ar', 'bilingual']).optional(), addressee: z.string().max(200).optional(), purpose: z.string().max(500).optional(), change: z.record(z.unknown()).optional(), force: z.boolean().default(false) }), response: { 201: letterOut, 400: errorSchema } } }, async (req, reply) => {
    const p = requireAuth(req);
    const res = await issueLetter(app, { ...req.body, userId: p.userId, hrRequestId: null });
    return reply.status(201).send(letterMap(await letterQuery().where('g.id', '=', res.id).executeTakeFirstOrThrow()));
  });

  r.get('/', { preHandler: requirePermission('letters:generate', 'letters:read:own'), schema: { tags: ['letters'], summary: 'Generated letters', querystring: paginationQuery.merge(z.object({ employeeId: z.string().uuid().optional(), status: z.string().optional() })), response: { 200: paginated(letterOut) } } }, async (req) => {
    const p = requireAuth(req); const q = req.query;
    let base = letterQuery();
    if (!hasPermission(p, 'letters:generate')) base = base.where('g.employee_id', '=', p.employeeId ?? '00000000-0000-0000-0000-000000000000');
    if (q.employeeId) base = base.where('g.employee_id', '=', q.employeeId);
    if (q.status) base = base.where('g.status', '=', q.status);
    const total = Number((await base.clearSelect().select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    const rows = await base.orderBy('g.created_at', 'desc').limit(q.pageSize).offset(offset(q)).execute();
    return { data: rows.map(letterMap), meta: pageMeta(q, total) };
  });
  r.get('/:id/html', { preHandler: requirePermission('letters:generate', 'letters:read:own'), schema: { tags: ['letters'], summary: 'Rendered letter (HTML, printable)', params: idParam, produces: ['text/html'] } }, async (req, reply) => {
    const p = requireAuth(req);
    const g = await app.db.selectFrom('generated_letters').select(['rendered_html', 'employee_id']).where('id', '=', req.params.id).executeTakeFirst();
    if (!g) throw notFound('Letter', req.params.id);
    if (!hasPermission(p, 'letters:generate') && g.employee_id !== p.employeeId) throw forbidden();
    return reply.type('text/html').send(g.rendered_html);
  });
  r.post('/:id/revoke', { preHandler: requirePermission('letters:generate'), schema: { tags: ['letters'], summary: 'Revoke an issued letter (verification then shows REVOKED)', params: idParam, body: z.object({ reason: z.string().min(3) }), response: { 200: z.object({ ok: z.boolean() }) } } }, async (req) => {
    const res = await app.db.updateTable('generated_letters').set({ status: 'REVOKED', revoked_at: new Date(), revoke_reason: req.body.reason }).where('id', '=', req.params.id).returning(['id', 'employee_id', 'letter_no']).executeTakeFirst();
    if (!res) throw notFound('Letter', req.params.id);
    await addTimeline(app.db, { employeeId: res.employee_id, type: 'LETTER', title: `Letter ${res.letter_no} revoked`, description: req.body.reason, refType: 'generated_letter', refId: res.id, actorUserId: req.principal!.userId });
    await app.audit(req, { action: 'letters.revoke', entityType: 'generated_letter', entityId: res.id, reason: req.body.reason });
    return { ok: true };
  });
  /** Public verification (no auth): confirms the letter exists and its status; exposes only letter number, type, employee number and name. */
  r.get('/verify/:code', { schema: { tags: ['letters'], summary: 'Public letter verification', security: [], params: z.object({ code: z.string().min(6).max(20) }), response: { 200: z.object({ valid: z.boolean(), letterNo: z.string().optional(), letterType: z.string().optional(), employeeNo: z.string().optional(), employeeName: z.string().optional(), status: z.string().optional(), issuedAt: z.string().nullable().optional() }) } } }, async (req) => {
    const v = await app.db.selectFrom('v_letter_verification').selectAll().where('verification_code', '=', req.params.code.toUpperCase()).executeTakeFirst();
    if (!v) return { valid: false };
    return { valid: v.status === 'ISSUED', letterNo: v.letter_no, letterType: v.letter_type, employeeNo: v.employee_no, employeeName: v.full_name_en, status: v.status, issuedAt: v.issued_at ? new Date(v.issued_at).toISOString() : null };
  });
};

/** Shared issuing routine (used directly by HR and by the HR-request applier after approval). */
export async function issueLetter(app: import('fastify').FastifyInstance, input: { employeeId: string; templateCode: string; language?: 'en' | 'ar' | 'bilingual'; addressee?: string; purpose?: string; change?: Record<string, unknown>; userId: string; hrRequestId: string | null; force?: boolean }): Promise<{ id: string; letterNo: string; verificationCode: string }> {
  const env = getEnv();
  const t = await app.db.selectFrom('letter_templates').selectAll().where('code', '=', input.templateCode.toUpperCase()).where('is_active', '=', true).executeTakeFirst();
  if (!t) throw badRequest(`Unknown template ${input.templateCode}`);
  if (t.requires_approval && !input.hrRequestId && !input.force) throw badRequest(`Template ${t.code} requires approval: create a letter request instead`);
  const vars = await letterVariables(app.db, input.employeeId, { addressee: input.addressee, purpose: input.purpose, change: input.change, company: COMPANY });
  const lang = input.language ?? t.language;
  const letterNo = await nextLetterNo(app.db);
  const code = verificationCode();
  const html = letterDocument({ htmlEn: lang !== 'ar' && t.body_en ? renderTemplate(t.body_en, vars) : null, htmlAr: lang !== 'en' && t.body_ar ? renderTemplate(t.body_ar, vars) : null, letterNo, verificationCode: code, verifyUrl: `${env.WEB_PUBLIC_URL}/verify/${code}`, company: COMPANY, signatoryName: t.signatory_name, signatoryTitle: t.signatory_title, signatoryTitleAr: t.signatory_title_ar });
  const g = await app.db.insertInto('generated_letters').values({ letter_no: letterNo, verification_code: code, template_id: t.id, employee_id: input.employeeId, language: lang, variables: JSON.stringify(vars), rendered_html: html, addressee: input.addressee ?? null, purpose: input.purpose ?? null, status: 'ISSUED', hr_request_id: input.hrRequestId, issued_by: input.userId, issued_at: new Date() }).returning('id').executeTakeFirstOrThrow();
  await addTimeline(app.db, { employeeId: input.employeeId, type: 'LETTER', title: `${t.name} issued`, description: `${letterNo}${input.purpose ? ` · ${input.purpose}` : ''}`, refType: 'generated_letter', refId: g.id, actorUserId: input.userId, visibility: 'EMPLOYEE' });
  await app.audit(null, { action: 'letters.generate', entityType: 'generated_letter', entityId: g.id, newValue: { employeeId: input.employeeId, template: t.code, letterNo }, approvalRef: input.hrRequestId });
  return { id: g.id, letterNo, verificationCode: code };
}
