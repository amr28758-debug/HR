/** Seed for the HR Operating System domains (job architecture, lookups, letter templates, training, performance, workflows). Idempotent. */
import type pg from 'pg';

export async function seedHrOs(c: pg.PoolClient, log: (m: string) => void): Promise<void> {
  // Career levels
  const levels = [['L1', 'Entry', 1], ['L2', 'Junior', 2], ['L3', 'Professional', 3], ['L4', 'Senior', 4], ['L5', 'Specialist', 5], ['L6', 'Supervisor', 6], ['L7', 'Manager', 7], ['L8', 'Senior Manager', 8], ['L9', 'Director', 9], ['L10', 'Executive', 10]];
  const lvl: Record<string, string> = {};
  for (const [code, name, rank] of levels) {
    const r = await c.query(`INSERT INTO career_levels(code, name, rank) VALUES ($1,$2,$3) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [code, name, rank]);
    lvl[code as string] = r.rows[0].id;
  }
  // Grades with salary bands (COMPANY POLICY EXAMPLES — REQUIRE HR CONFIRMATION)
  const grades = [['G1', 'L1', 1000, 1400, 1800], ['G2', 'L2', 1500, 2200, 3000], ['G3', 'L3', 2500, 3800, 5000], ['G4', 'L4', 4000, 6000, 8000], ['G5', 'L5', 6000, 9000, 12000], ['G6', 'L6', 8000, 12000, 16000], ['G7', 'L7', 12000, 18000, 25000], ['G8', 'L8', 18000, 26000, 35000], ['G9', 'L9', 25000, 38000, 50000], ['G10', 'L10', 40000, 60000, 90000]];
  const grd: Record<string, string> = {};
  for (const [i, [code, l, mn, md, mx]] of grades.entries()) {
    const r = await c.query(`INSERT INTO grades(code, name, career_level_id, min_salary, mid_salary, max_salary, sort_order) VALUES ($1,$1,$2,$3,$4,$5,$6) ON CONFLICT (code) DO UPDATE SET min_salary = EXCLUDED.min_salary, mid_salary = EXCLUDED.mid_salary, max_salary = EXCLUDED.max_salary RETURNING id`, [code, lvl[l as string], mn, md, mx, i + 1]);
    grd[code as string] = r.rows[0].id;
  }
  // Job families & functions
  const families: [string, string, [string, string][]][] = [
    ['ENG', 'Engineering', [['CIVIL', 'Civil Engineering'], ['MEP', 'MEP Engineering'], ['QS', 'Quantity Surveying'], ['PLAN', 'Planning']]],
    ['OPS', 'Site Operations', [['SUP', 'Site Supervision'], ['TRADE', 'Skilled Trades'], ['LAB', 'General Labour'], ['PLANT', 'Plant & Drivers']]],
    ['HSE', 'Health, Safety & Environment', [['HSE', 'HSE']]],
    ['CORP', 'Corporate', [['HR', 'Human Resources'], ['FIN', 'Finance'], ['IT', 'Information Technology'], ['ADM', 'Administration'], ['PROC', 'Procurement'], ['MGMT', 'Management']]],
  ];
  const fn: Record<string, string> = {};
  for (const [fcode, fname, funcs] of families) {
    const f = await c.query(`INSERT INTO job_families(code, name) VALUES ($1,$2) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [fcode, fname]);
    for (const [code, name] of funcs) {
      const r = await c.query(`INSERT INTO job_functions(job_family_id, code, name) VALUES ($1,$2,$3) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [f.rows[0].id, code, name]);
      fn[code] = r.rows[0].id;
    }
  }
  // Link designations: letter grade A..F → G10..G2, functions by title
  const map: Record<string, [string, string]> = { GM: ['MGMT', 'G10'], PM: ['MGMT', 'G8'], CM: ['SUP', 'G7'], SE: ['CIVIL', 'G5'], PE: ['CIVIL', 'G5'], QSE: ['QS', 'G5'], HSE: ['HSE', 'G4'], FM: ['SUP', 'G4'], CH: ['SUP', 'G3'], MAS: ['TRADE', 'G2'], CARP: ['TRADE', 'G2'], STF: ['TRADE', 'G2'], ELEC: ['TRADE', 'G3'], PLUM: ['TRADE', 'G2'], HELP: ['LAB', 'G1'], LAB: ['LAB', 'G1'], DRV: ['PLANT', 'G2'], OPR: ['PLANT', 'G3'], HRO: ['HR', 'G5'], ACC: ['FIN', 'G5'], ITS: ['IT', 'G5'], ADMO: ['ADM', 'G4'], SEC: ['ADM', 'G3'] };
  for (const [code, [func, g]] of Object.entries(map)) {
    await c.query(`UPDATE designations SET job_function_id = $2, job_family_id = (SELECT job_family_id FROM job_functions WHERE id = $2), default_grade_id = $3, career_level_id = (SELECT career_level_id FROM grades WHERE id = $3) WHERE code = $1`, [code, fn[func], grd[g]]);
  }
  await c.query(`UPDATE employees e SET job_family_id = d.job_family_id, job_function_id = d.job_function_id, grade_id = d.default_grade_id, career_level_id = d.career_level_id FROM designations d WHERE d.id = e.designation_id AND e.grade_id IS NULL`);
  log('job architecture seeded');

  // Job descriptions (one approved example)
  const se = await c.query(`SELECT id FROM designations WHERE code = 'SE'`);
  const civ = await c.query(`SELECT id FROM departments WHERE code = 'CIVIL'`);
  if (se.rowCount && (await c.query(`SELECT 1 FROM job_descriptions WHERE code = 'JD-CIV-SE'`)).rowCount === 0) {
    const jd = await c.query(`INSERT INTO job_descriptions(code, designation_id, department_id, job_family_id, job_function_id, grade_id, career_level_id, location, status, current_version) VALUES ('JD-CIV-SE',$1,$2,(SELECT job_family_id FROM job_functions WHERE code='CIVIL'),$3,$4,$5,'Project sites, UAE','APPROVED',1) RETURNING id`, [se.rows[0].id, civ.rows[0]?.id ?? null, fn['CIVIL'], grd['G5'], lvl['L5']]);
    await c.query(`INSERT INTO job_description_versions(job_description_id, version, effective_from, purpose, responsibilities, duties, qualifications, experience, skills, technical_competencies, behavioural_competencies, kpis, required_certifications, status, approved_at)
      VALUES ($1,1,'2026-01-01','Deliver civil works on site safely, on time and to specification.',
      '["Supervise daily civil works execution","Coordinate with MEP and finishing teams","Review drawings and method statements","Manage subcontractor workforce on site"]',
      '["Daily site inspections","Progress reporting to Construction Manager","Material take-off verification","Quality checks and NCR follow-up"]',
      '["B.Sc. Civil Engineering","Registered with relevant municipality (preferred)"]','5+ years in building construction in the GCC',
      '["AutoCAD","Primavera P6","MS Office"]','["Structural works","Concrete technology","Formwork systems"]','["Ownership","Communication","Team leadership","Safety mindset"]',
      '["Schedule adherence ≥ 95%","Zero lost-time injuries","Rework < 2%"]','["HSE Induction","Working at Height"]','APPROVED', now())`, [jd.rows[0].id]);
  }

  // Lookups
  const lookups: [string, [string, string][]][] = [
    ['BONUS_TYPE', [['PERFORMANCE', 'Performance bonus'], ['PROJECT', 'Project completion bonus'], ['REFERRAL', 'Referral bonus'], ['EID', 'Eid bonus'], ['RETENTION', 'Retention bonus'], ['OTHER', 'Other']]],
    ['DISCIPLINARY_CATEGORY', [['VERBAL_WARNING', 'Verbal warning'], ['WRITTEN_WARNING', 'Written warning'], ['FINAL_WARNING', 'Final warning'], ['DISCIPLINARY_ACTION', 'Disciplinary action'], ['INVESTIGATION', 'Investigation'], ['SUSPENSION', 'Suspension'], ['OTHER', 'Other']]],
    ['TRAINING_CATEGORY', [['HSE', 'Health & Safety'], ['TECHNICAL', 'Technical'], ['SOFTWARE', 'Software'], ['LEADERSHIP', 'Leadership'], ['COMPLIANCE', 'Compliance'], ['GENERAL', 'General']]],
    ['DOCUMENT_CATEGORY', [['IDENTITY', 'Identity'], ['LABOUR', 'Labour'], ['CONTRACT', 'Contract'], ['INSURANCE', 'Insurance'], ['EDUCATION', 'Education'], ['TRAINING', 'Training'], ['COMPANY', 'Company documents'], ['OTHER', 'Other']]],
    ['EXIT_REASON', [['RESIGNATION', 'Resignation'], ['END_OF_CONTRACT', 'End of contract'], ['TERMINATION', 'Termination'], ['REDUNDANCY', 'Redundancy'], ['RETIREMENT', 'Retirement'], ['OTHER', 'Other']]],
    ['NOTE_CATEGORY', [['GENERAL', 'General'], ['HR', 'HR'], ['PAYROLL', 'Payroll'], ['PERFORMANCE', 'Performance'], ['WELFARE', 'Welfare']]],
    ['LETTER_CATEGORY', [['CERTIFICATE', 'Certificates'], ['BANK', 'Bank & finance'], ['GOVERNMENT', 'Government & visa'], ['HR', 'HR letters'], ['DISCIPLINARY', 'Disciplinary'], ['OTHER', 'Other']]],
  ];
  for (const [cat, items] of lookups) for (const [i, [code, name]] of items.entries()) await c.query(`INSERT INTO lookups(category, code, name, sort_order) VALUES ($1,$2,$3,$4) ON CONFLICT (category, code) DO UPDATE SET name = EXCLUDED.name`, [cat, code, name, (i + 1) * 10]);
  for (const [code, name] of [['ASSET_DAMAGE', 'Asset damage'], ['PENALTY', 'Penalty']]) await c.query(`INSERT INTO salary_components(code, name, kind, calc_method, is_fixed_pay, sort_order) VALUES ($1,$2,'DEDUCTION','FIXED',false,260) ON CONFLICT (code) DO NOTHING`, [code, name]);
  log('lookups seeded');

  // Letter templates (bilingual; placeholders resolved by the letters module)
  const sig = ['Human Resources Manager', 'مدير الموارد البشرية'];
  const templates: [string, string, string, string, boolean, string, string][] = [
    ['SALARY_CERTIFICATE', 'Salary Certificate', 'CERTIFICATE', 'bilingual', false,
      `<p>Date: {{letter.issueDate}}</p><p>To: {{letter.addressee}}</p><h3>SALARY CERTIFICATE</h3><p>This is to certify that <b>{{employee.name}}</b>, holder of passport no. {{employee.passportNo}}, has been employed with <b>{{company.name}}</b> since {{employee.joiningDate}} as <b>{{employee.designation}}</b> in the {{employee.department}} department.</p><p>The employee's current monthly salary is as follows:</p><table><tr><td>Basic salary</td><td>AED {{salary.basic}}</td></tr><tr><td>Allowances</td><td>AED {{salary.allowances}}</td></tr><tr><td><b>Total monthly salary</b></td><td><b>AED {{salary.gross}}</b></td></tr></table><p>This certificate is issued at the request of the employee for {{letter.purpose}} and does not constitute any liability on the company.</p>`,
      `<p>التاريخ: {{letter.issueDate}}</p><p>إلى: {{letter.addressee}}</p><h3>شهادة راتب</h3><p>نشهد بأن السيد/ة <b>{{employee.nameAr}}</b>، حامل/ة جواز السفر رقم {{employee.passportNo}}، يعمل لدى <b>{{company.nameAr}}</b> منذ {{employee.joiningDate}} بوظيفة <b>{{employee.designation}}</b> في قسم {{employee.department}}.</p><p>الراتب الشهري الحالي كما يلي:</p><table><tr><td>الراتب الأساسي</td><td>{{salary.basic}} درهم</td></tr><tr><td>البدلات</td><td>{{salary.allowances}} درهم</td></tr><tr><td><b>إجمالي الراتب الشهري</b></td><td><b>{{salary.gross}} درهم</b></td></tr></table><p>أُصدرت هذه الشهادة بناءً على طلب الموظف لغرض {{letter.purpose}} دون أدنى مسؤولية على الشركة.</p>`],
    ['EMPLOYMENT_CERTIFICATE', 'Employment Certificate', 'CERTIFICATE', 'bilingual', false,
      `<p>Date: {{letter.issueDate}}</p><h3>TO WHOM IT MAY CONCERN</h3><p>This is to certify that <b>{{employee.name}}</b> (Employee No. {{employee.no}}) is employed with <b>{{company.name}}</b> as <b>{{employee.designation}}</b> since {{employee.joiningDate}} and is currently assigned to {{employee.project}}.</p><p>This certificate is issued upon the employee's request for {{letter.purpose}}.</p>`,
      `<p>التاريخ: {{letter.issueDate}}</p><h3>إلى من يهمه الأمر</h3><p>نشهد بأن <b>{{employee.nameAr}}</b> (الرقم الوظيفي {{employee.no}}) يعمل لدى <b>{{company.nameAr}}</b> بوظيفة <b>{{employee.designation}}</b> منذ {{employee.joiningDate}} ويعمل حالياً في {{employee.project}}.</p><p>أُصدرت هذه الشهادة بناءً على طلب الموظف لغرض {{letter.purpose}}.</p>`],
    ['EXPERIENCE_CERTIFICATE', 'Experience Certificate', 'CERTIFICATE', 'en', false,
      `<p>Date: {{letter.issueDate}}</p><h3>EXPERIENCE CERTIFICATE</h3><p>This is to certify that <b>{{employee.name}}</b> worked with <b>{{company.name}}</b> from {{employee.joiningDate}} to {{employee.lastWorkingDate}} as <b>{{employee.designation}}</b>.</p><p>During this period the employee's conduct and performance were found satisfactory. We wish them success in their future endeavours.</p>`, ''],
    ['NOC', 'No Objection Certificate', 'GOVERNMENT', 'bilingual', true,
      `<p>Date: {{letter.issueDate}}</p><p>To: {{letter.addressee}}</p><h3>NO OBJECTION CERTIFICATE</h3><p><b>{{company.name}}</b> has no objection to <b>{{employee.name}}</b>, holder of passport no. {{employee.passportNo}}, employed as {{employee.designation}} since {{employee.joiningDate}}, for the purpose of {{letter.purpose}}.</p>`,
      `<p>التاريخ: {{letter.issueDate}}</p><p>إلى: {{letter.addressee}}</p><h3>شهادة عدم ممانعة</h3><p>لا تمانع <b>{{company.nameAr}}</b> في قيام <b>{{employee.nameAr}}</b>، حامل/ة جواز السفر رقم {{employee.passportNo}}، والذي يعمل بوظيفة {{employee.designation}} منذ {{employee.joiningDate}}، بـ{{letter.purpose}}.</p>`],
    ['SALARY_TRANSFER', 'Salary Transfer Letter', 'BANK', 'en', false,
      `<p>Date: {{letter.issueDate}}</p><p>To: {{letter.addressee}}</p><h3>SALARY TRANSFER LETTER</h3><p>We confirm that the monthly salary of <b>{{employee.name}}</b> (Employee No. {{employee.no}}), amounting to <b>AED {{salary.gross}}</b>, will be transferred to the employee's account with your bank, IBAN {{employee.iban}}, as long as the employee remains in our employment.</p>`, ''],
    ['PROMOTION_LETTER', 'Promotion Letter', 'HR', 'en', false,
      `<p>Date: {{letter.issueDate}}</p><p>Dear {{employee.name}},</p><h3>PROMOTION</h3><p>We are pleased to inform you that you have been promoted to <b>{{change.newDesignation}}</b> (Grade {{change.newGrade}}) effective <b>{{change.effectiveDate}}</b>. Your revised monthly salary will be <b>AED {{change.newGross}}</b>.</p><p>We congratulate you and look forward to your continued contribution.</p>`, ''],
    ['INCREMENT_LETTER', 'Increment Letter', 'HR', 'en', false,
      `<p>Date: {{letter.issueDate}}</p><p>Dear {{employee.name}},</p><h3>SALARY INCREMENT</h3><p>In recognition of your contribution, your monthly salary has been revised from AED {{change.oldGross}} to <b>AED {{change.newGross}}</b> effective <b>{{change.effectiveDate}}</b>.</p>`, ''],
    ['WARNING_LETTER', 'Warning Letter', 'DISCIPLINARY', 'en', true,
      `<p>Date: {{letter.issueDate}}</p><p>To: {{employee.name}} ({{employee.no}})</p><h3>WARNING LETTER</h3><p>This letter serves as a formal warning regarding the following: {{letter.purpose}}.</p><p>You are expected to take immediate corrective action. Any recurrence may result in further disciplinary action in accordance with company policy.</p>`, ''],
    ['OFFER_LETTER', 'Offer Letter', 'HR', 'en', true,
      `<p>Date: {{letter.issueDate}}</p><p>Dear {{employee.name}},</p><h3>OFFER OF EMPLOYMENT</h3><p>We are pleased to offer you the position of <b>{{employee.designation}}</b> in the {{employee.department}} department at a monthly salary of <b>AED {{salary.gross}}</b> (basic AED {{salary.basic}}).</p>`, ''],
  ];
  for (const [code, name, cat, lang, appr, en, ar] of templates) {
    await c.query(`INSERT INTO letter_templates(code, version, name, category, language, body_en, body_ar, requires_approval, signatory_name, signatory_title, signatory_title_ar) VALUES ($1,1,$2,$3,$4,$5,$6,$7,'',$8,$9) ON CONFLICT (code, version) DO UPDATE SET body_en = EXCLUDED.body_en, body_ar = EXCLUDED.body_ar, requires_approval = EXCLUDED.requires_approval`, [code, name, cat, lang, en, ar || null, appr, sig[0], sig[1]]);
  }
  log('letter templates seeded');

  // Training catalog
  for (const [code, title, cat, hrs, valid, mand] of [['HSE-IND', 'HSE Induction', 'HSE', 4, 12, true], ['WAH', 'Working at Height', 'HSE', 8, 24, false], ['FIRST-AID', 'First Aid', 'HSE', 16, 36, false], ['P6', 'Primavera P6', 'SOFTWARE', 24, null, false], ['ACAD', 'AutoCAD', 'SOFTWARE', 24, null, false], ['LEAD-1', 'Leadership Essentials', 'LEADERSHIP', 16, null, false]]) {
    await c.query(`INSERT INTO training_catalog(code, title, category, duration_hours, validity_months, is_mandatory) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (code) DO NOTHING`, [code, title, cat, hrs, valid, mand]);
  }
  // Performance cycle 2026
  await c.query(`INSERT INTO performance_cycles(name, cycle_year, period_start, period_end, review_due, status) SELECT '2026 Annual Review', 2026, '2026-01-01', '2026-12-31', '2027-01-31', 'OPEN' WHERE NOT EXISTS (SELECT 1 FROM performance_cycles WHERE cycle_year = 2026)`);

  // Workflow definitions for HR requests
  const wf: [string, string, string, object[]][] = [
    ['PROMOTION', 'Promotion', 'hr_request', [{ key: 'manager', approverType: 'MANAGER' }, { key: 'hr', approverType: 'ROLE', roleCode: 'HR_MANAGER' }, { key: 'finance', approverType: 'ROLE', roleCode: 'FINANCE_MANAGER' }, { key: 'management', approverType: 'ROLE', roleCode: 'MANAGEMENT' }]],
    ['TRANSFER', 'Transfer', 'hr_request', [{ key: 'manager', approverType: 'MANAGER' }, { key: 'hr', approverType: 'ROLE', roleCode: 'HR_ADMIN' }]],
    ['SALARY_CHANGE', 'Salary change', 'hr_request', [{ key: 'hr', approverType: 'ROLE', roleCode: 'HR_MANAGER' }, { key: 'finance', approverType: 'ROLE', roleCode: 'FINANCE_MANAGER' }, { key: 'management', approverType: 'ROLE', roleCode: 'MANAGEMENT' }]],
    ['INCREMENT', 'Annual increment', 'hr_request', [{ key: 'hr', approverType: 'ROLE', roleCode: 'HR_MANAGER' }, { key: 'finance', approverType: 'ROLE', roleCode: 'FINANCE_MANAGER' }, { key: 'management', approverType: 'ROLE', roleCode: 'MANAGEMENT' }]],
    ['LOAN', 'Employee loan', 'hr_request', [{ key: 'manager', approverType: 'MANAGER' }, { key: 'hr', approverType: 'ROLE', roleCode: 'HR_MANAGER' }, { key: 'finance', approverType: 'ROLE', roleCode: 'FINANCE_MANAGER' }]],
    ['ADVANCE', 'Salary advance', 'hr_request', [{ key: 'manager', approverType: 'MANAGER' }, { key: 'finance', approverType: 'ROLE', roleCode: 'FINANCE' }]],
    ['BONUS', 'Bonus', 'hr_request', [{ key: 'hr', approverType: 'ROLE', roleCode: 'HR_MANAGER' }, { key: 'finance', approverType: 'ROLE', roleCode: 'FINANCE_MANAGER' }]],
    ['DEDUCTION', 'Deduction', 'hr_request', [{ key: 'hr', approverType: 'ROLE', roleCode: 'HR_MANAGER' }]],
    ['LETTER', 'Letter approval', 'hr_request', [{ key: 'hr', approverType: 'ROLE', roleCode: 'HR_MANAGER' }]],
    ['TRAINING', 'Training request', 'hr_request', [{ key: 'manager', approverType: 'MANAGER' }, { key: 'hr', approverType: 'ROLE', roleCode: 'HR_ADMIN' }]],
    ['DISCIPLINARY', 'Disciplinary action', 'hr_request', [{ key: 'hr', approverType: 'ROLE', roleCode: 'HR_MANAGER' }, { key: 'management', approverType: 'ROLE', roleCode: 'MANAGEMENT' }]],
    ['DOCUMENT', 'Document request', 'hr_request', [{ key: 'hr', approverType: 'ROLE', roleCode: 'HR_ADMIN' }]],
    ['HR_RESIGNATION', 'Resignation acceptance', 'hr_request', [{ key: 'manager', approverType: 'MANAGER' }, { key: 'hr', approverType: 'ROLE', roleCode: 'HR_MANAGER' }]],
    ['HR_TERMINATION', 'Termination approval', 'hr_request', [{ key: 'hr', approverType: 'ROLE', roleCode: 'HR_MANAGER' }, { key: 'management', approverType: 'ROLE', roleCode: 'MANAGEMENT' }]],
    ['OTHER', 'Other request', 'hr_request', [{ key: 'hr', approverType: 'ROLE', roleCode: 'HR_ADMIN' }]],
    ['PAYROLL_ADJUSTMENT', 'Payroll adjustment', 'payroll_adjustment', [{ key: 'finance', approverType: 'ROLE', roleCode: 'FINANCE_MANAGER' }]],
  ];
  for (const [code, name, entity, steps] of wf) {
    await c.query(`INSERT INTO workflow_definitions(code, version, name, entity_type, trigger, conditions, steps, actions) VALUES ($1,1,$2,$3,$4,'[]',$5,$6) ON CONFLICT (code, version) DO UPDATE SET steps = EXCLUDED.steps, entity_type = EXCLUDED.entity_type`, [code, name, entity, JSON.stringify({ event: `${code.toLowerCase()}.requested` }), JSON.stringify(steps), JSON.stringify([{ type: 'set_status', onApprove: 'APPROVED', onReject: 'REJECTED' }])]);
  }
  // Timeline backfill: JOINED events
  await c.query(`INSERT INTO employee_timeline_events(employee_id, event_type, title, description, occurred_at, visibility)
    SELECT e.id, 'JOINED', 'Joined Burtplace', coalesce(g.title, '') || CASE WHEN d.name IS NOT NULL THEN ' · ' || d.name ELSE '' END, coalesce(e.joining_date, e.created_at::date)::timestamptz, 'EMPLOYEE'
    FROM employees e LEFT JOIN designations g ON g.id = e.designation_id LEFT JOIN departments d ON d.id = e.department_id
    WHERE NOT EXISTS (SELECT 1 FROM employee_timeline_events t WHERE t.employee_id = e.id AND t.event_type = 'JOINED')`);
  log('workflows, training, performance & timeline seeded');
}
