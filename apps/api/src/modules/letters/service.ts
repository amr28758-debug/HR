import { sql, type Kysely } from 'kysely';
import { randomBytes } from 'node:crypto';
import type { DB } from '@burtplace/database';

/** Build the variable set available to letter templates from live employee data (restricted fields included only when the caller may see them). */
export async function letterVariables(db: Kysely<DB>, employeeId: string, extra: { addressee?: string; purpose?: string; change?: Record<string, unknown>; company: { name: string; nameAr: string } }): Promise<Record<string, any>> {
  const e = await db.selectFrom('employees as e').leftJoin('designations as d', 'd.id', 'e.designation_id').leftJoin('departments as dep', 'dep.id', 'e.department_id').leftJoin('projects as p', 'p.id', 'e.project_id').leftJoin('sites as s', 's.id', 'e.site_id').leftJoin('grades as g', 'g.id', 'e.grade_id').leftJoin('employees as m', 'm.id', 'e.manager_employee_id')
    .select(['e.id', 'e.employee_no', 'e.full_name_en', 'e.full_name_ar', 'e.joining_date', 'e.last_working_date', 'e.nationality', 'e.bank_iban', 'e.bank_name', 'e.employment_type', 'd.title as designation', 'd.title_ar as designation_ar', 'dep.name as department', 'dep.name_ar as department_ar', 'p.name as project', 'p.code as project_code', 's.name as site', 'g.code as grade', 'm.full_name_en as manager']).where('e.id', '=', employeeId).executeTakeFirstOrThrow();
  const passport = await db.selectFrom('employee_documents').select('document_number').where('employee_id', '=', employeeId).where('document_type', '=', 'PASSPORT').where('deleted_at', 'is', null).orderBy('created_at', 'desc').executeTakeFirst();
  const eid = await db.selectFrom('employee_documents').select('document_number').where('employee_id', '=', employeeId).where('document_type', '=', 'EMIRATES_ID').where('deleted_at', 'is', null).orderBy('created_at', 'desc').executeTakeFirst();
  const sal = await db.selectFrom('employee_salary_structures').select(['basic_salary', 'gross_salary', 'currency']).where('employee_id', '=', employeeId).orderBy('effective_from', 'desc').orderBy('version', 'desc').executeTakeFirst();
  const fmt = (d: string | null) => (d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }) : '—');
  const money = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const today = new Date();
  return {
    company: { name: extra.company.name, nameAr: extra.company.nameAr },
    employee: { no: e.employee_no, name: e.full_name_en, nameAr: e.full_name_ar ?? e.full_name_en, designation: e.designation ?? '—', designationAr: e.designation_ar ?? e.designation ?? '—', department: e.department ?? '—', departmentAr: e.department_ar ?? e.department ?? '—', project: e.project ? `${e.project_code} · ${e.project}` : e.site ?? '—', site: e.site ?? '—', grade: e.grade ?? '—', manager: e.manager ?? '—', nationality: e.nationality ?? '—', joiningDate: fmt(e.joining_date), lastWorkingDate: fmt(e.last_working_date), employmentType: e.employment_type, passportNo: passport?.document_number ?? '—', emiratesId: eid?.document_number ?? '—', iban: e.bank_iban ?? '—', bank: e.bank_name ?? '—' },
    salary: { basic: money(sal?.basic_salary), gross: money(sal?.gross_salary), allowances: money(sal ? Number(sal.gross_salary) - Number(sal.basic_salary) : null), currency: sal?.currency ?? 'AED' },
    letter: { issueDate: today.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }), issueDateAr: today.toLocaleDateString('ar-AE', { day: 'numeric', month: 'long', year: 'numeric' }), addressee: extra.addressee ?? 'To whom it may concern', purpose: extra.purpose ?? '—' },
    change: extra.change ?? {},
  };
}

/** Replace {{a.b.c}} placeholders; unknown paths render as a visible marker so HR notices missing data. */
export function renderTemplate(body: string, vars: Record<string, any>): string {
  return body.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, path: string) => {
    const v = path.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), vars);
    return v === undefined || v === null ? `[${path}]` : String(v);
  });
}

export function templateVariableNames(body: string): string[] {
  return [...new Set([...body.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)].map((m) => m[1]!))];
}

export async function nextLetterNo(db: Kysely<DB>): Promise<string> {
  const r = (await sql<{ n: number }>`SELECT nextval('letter_no_seq')::int AS n`.execute(db)).rows[0]!;
  return `BP-LTR-${new Date().getFullYear()}-${String(r.n).padStart(6, '0')}`;
}
export const verificationCode = () => randomBytes(9).toString('base64url').replace(/[^A-Za-z0-9]/g, 'X').slice(0, 12).toUpperCase();

/** Wrap rendered body in a letterhead document (EN / AR / bilingual). */
export function letterDocument(opts: { htmlEn: string | null; htmlAr: string | null; letterNo: string; verificationCode: string; verifyUrl: string; qrSvg?: string | null; company: { name: string; nameAr: string }; signatoryName?: string | null; signatoryTitle?: string | null; signatoryTitleAr?: string | null }): string {
  const sig = (title: string | null | undefined, name: string | null | undefined, rtl = false) => `<div class="sig" ${rtl ? 'dir="rtl"' : ''}><div class="line"></div><b>${name || '________________'}</b><br><span>${title ?? ''}</span></div>`;
  const en = opts.htmlEn ? `<section class="en">${opts.htmlEn}${sig(opts.signatoryTitle, opts.signatoryName)}</section>` : '';
  const ar = opts.htmlAr ? `<section class="ar" dir="rtl">${opts.htmlAr}${sig(opts.signatoryTitleAr, opts.signatoryName, true)}</section>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${opts.letterNo}</title><style>
  body{font-family:"Plus Jakarta Sans","IBM Plex Sans Arabic",Arial,sans-serif;color:#161B26;margin:0;padding:48px 56px;font-size:14px;line-height:1.6}
  .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #152D58;padding-bottom:14px;margin-bottom:28px}
  .head h1{font-size:20px;margin:0;color:#152D58}.head small{color:#677080;display:block}.meta{text-align:right;font-size:12px;color:#677080}
  h3{color:#152D58;letter-spacing:.06em;margin:18px 0 10px}table{border-collapse:collapse;margin:10px 0}td{padding:6px 14px 6px 0;border-bottom:1px solid #E5E3DD}
  section.ar{margin-top:40px;border-top:1px dashed #E5E3DD;padding-top:24px}.sig{margin-top:44px;width:260px}.sig .line{border-top:1px solid #161B26;margin-bottom:6px}
  .foot{margin-top:48px;border-top:1px solid #E5E3DD;padding-top:10px;font-size:11px;color:#677080;display:flex;justify-content:space-between;align-items:center}
  .qr{width:84px;text-align:center;font-size:9px;color:#152D58}.qr svg{width:72px;height:72px;display:block;margin:0 auto 2px}
  @media print{body{padding:24px}}
  </style></head><body>
  <div class="head"><div><h1>${opts.company.name}</h1><small>${opts.company.nameAr}</small></div><div class="meta">Ref: <b>${opts.letterNo}</b><br>Verification: ${opts.verificationCode}</div></div>
  ${en}${ar}
  <div class="foot"><span>Verify this letter at ${opts.verifyUrl}</span><div class="qr">${opts.qrSvg ?? ''}${opts.verificationCode}</div></div>
  </body></html>`;
}
