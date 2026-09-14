/**
 * Realistic development seed. NO real personal data — names are synthetic.
 * Idempotent: safe to run repeatedly (uses ON CONFLICT DO NOTHING / natural keys).
 */
import type pg from 'pg';
import bcrypt from 'bcryptjs';
import { PERMISSIONS, ROLE_PERMISSIONS } from './rbac.js';

type Log = (msg: string) => void;

const FIRST = ['Ahmed', 'Mohammed', 'Ali', 'Omar', 'Khalid', 'Yousef', 'Rashid', 'Saeed', 'Tariq', 'Bilal', 'Imran', 'Faisal', 'Hassan', 'Ibrahim', 'Zaid', 'Ravi', 'Suresh', 'Anil', 'Manoj', 'Pradeep', 'Arjun', 'Vikram', 'Sanjay', 'Rahul', 'Deepak', 'John', 'Peter', 'Mark', 'Sara', 'Fatima', 'Mariam', 'Noor', 'Layla', 'Priya', 'Anita', 'Maria'];
const LAST = ['Al Mansoori', 'Al Hashimi', 'Khan', 'Hussain', 'Rahman', 'Siddiqui', 'Kumar', 'Sharma', 'Nair', 'Pillai', 'Reddy', 'Singh', 'Patel', 'Fernandes', 'Dsouza', 'Ahmed', 'Abdullah', 'Yusuf', 'Ibrahim', 'Mahmoud'];
const NATIONALITIES = ['AE', 'IN', 'PK', 'BD', 'EG', 'PH', 'NP', 'LK', 'JO', 'SY'];

function pick<T>(arr: readonly T[], i: number): T { return arr[i % arr.length] as T; }
function pad(n: number, w = 3): string { return String(n).padStart(w, '0'); }

export async function seed(pool: pg.Pool, log: Log = () => {}): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');

    // ── RBAC ────────────────────────────────────────────────────────────────
    for (const code of PERMISSIONS) {
      await c.query('INSERT INTO permissions(code) VALUES ($1) ON CONFLICT (code) DO NOTHING', [code]);
    }
    for (const [code, def] of Object.entries(ROLE_PERMISSIONS)) {
      await c.query(
        `INSERT INTO roles(code, name, description, is_system) VALUES ($1,$2,$3,true)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description`,
        [code, def.name, def.description],
      );
      await c.query('DELETE FROM role_permissions WHERE role_id = (SELECT id FROM roles WHERE code = $1)', [code]);
      await c.query(
        `INSERT INTO role_permissions(role_id, permission_id)
         SELECT r.id, p.id FROM roles r, permissions p WHERE r.code = $1 AND p.code = ANY($2::text[])`,
        [code, def.permissions],
      );
    }
    log('rbac seeded');

    // ── Users (local dev accounts; password: Password123!) ──────────────────
    const pw = await bcrypt.hash('Password123!', 10);
    const users: Record<string, string> = {};
    const devUsers: [string, string, string][] = [
      ['admin@burtplace.local', 'System Administrator', 'SUPER_ADMIN'],
      ['hr.admin@burtplace.local', 'HR Administrator', 'HR_ADMIN'],
      ['hr.manager@burtplace.local', 'HR Manager', 'HR_MANAGER'],
      ['payroll@burtplace.local', 'Payroll Officer', 'PAYROLL_OFFICER'],
      ['finance@burtplace.local', 'Finance Manager', 'FINANCE_MANAGER'],
      ['it.admin@burtplace.local', 'IT Administrator', 'IT_ADMIN'],
      ['pm.c31@burtplace.local', 'Project Manager C31', 'PROJECT_MANAGER'],
      ['management@burtplace.local', 'Management', 'MANAGEMENT'],
      ['auditor@burtplace.local', 'Auditor', 'AUDITOR'],
      ['employee@burtplace.local', 'Sample Employee', 'EMPLOYEE'],
    ];
    for (const [email, name, role] of devUsers) {
      const r = await c.query(
        `INSERT INTO users(email, display_name, local_password_hash) VALUES ($1,$2,$3)
         ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING id`,
        [email, name, pw],
      );
      users[email] = r.rows[0].id;
      await c.query(
        `INSERT INTO user_roles(user_id, role_id) SELECT $1, id FROM roles WHERE code = $2 ON CONFLICT DO NOTHING`,
        [users[email], role],
      );
    }
    // Service account for device gateway
    const svc = await c.query(
      `INSERT INTO users(email, display_name, is_service_account) VALUES ('svc.device-gateway@burtplace.local','Device Gateway', true)
       ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING id`,
    );
    await c.query(`INSERT INTO user_roles(user_id, role_id) SELECT $1, id FROM roles WHERE code = 'SERVICE_DEVICE_GATEWAY' ON CONFLICT DO NOTHING`, [svc.rows[0].id]);
    log('users seeded');

    // ── Organization ────────────────────────────────────────────────────────
    const costCenters = [['CC-HO', 'Head Office'], ['CC-OPS', 'Operations'], ['CC-C31', 'Project C31'], ['CC-C42', 'Project C42'], ['CC-C55', 'Project C55']];
    const cc: Record<string, string> = {};
    for (const [code, name] of costCenters) {
      const r = await c.query(`INSERT INTO cost_centers(code, name) VALUES ($1,$2) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [code, name]);
      cc[code!] = r.rows[0].id;
    }
    const departments = [
      ['MGMT', 'Management', 'الإدارة', 'CC-HO'], ['HR', 'Human Resources', 'الموارد البشرية', 'CC-HO'], ['FIN', 'Finance & Accounts', 'المالية', 'CC-HO'],
      ['IT', 'Information Technology', 'تقنية المعلومات', 'CC-HO'], ['ADM', 'Administration', 'الشؤون الإدارية', 'CC-HO'], ['PROC', 'Procurement', 'المشتريات', 'CC-HO'],
      ['ENG', 'Engineering', 'الهندسة', 'CC-OPS'], ['QS', 'Quantity Surveying', 'حصر الكميات', 'CC-OPS'], ['QHSE', 'QHSE', 'الجودة والسلامة', 'CC-OPS'],
      ['PLANT', 'Plant & Equipment', 'المعدات', 'CC-OPS'], ['CIVIL', 'Civil Works', 'الأعمال المدنية', 'CC-OPS'], ['MEP', 'MEP', 'الأعمال الكهروميكانيكية', 'CC-OPS'],
      ['FINISH', 'Finishing', 'التشطيبات', 'CC-OPS'], ['LOG', 'Logistics & Camp', 'اللوجستيات', 'CC-OPS'],
    ];
    const dept: Record<string, string> = {};
    for (const [code, name, ar, ccc] of departments) {
      const r = await c.query(
        `INSERT INTO departments(code, name, name_ar, cost_center_id) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [code, name, ar, cc[ccc!]],
      );
      dept[code!] = r.rows[0].id;
    }
    const designations = [
      ['GM', 'General Manager', 'A'], ['PM', 'Project Manager', 'B'], ['CM', 'Construction Manager', 'B'], ['SE', 'Site Engineer', 'C'], ['PE', 'Project Engineer', 'C'],
      ['QSE', 'Quantity Surveyor', 'C'], ['HSE', 'HSE Officer', 'C'], ['FM', 'Foreman', 'D'], ['CH', 'Charge Hand', 'D'], ['MAS', 'Mason', 'E'], ['CARP', 'Carpenter', 'E'],
      ['STF', 'Steel Fixer', 'E'], ['ELEC', 'Electrician', 'E'], ['PLUM', 'Plumber', 'E'], ['HELP', 'Helper', 'F'], ['LAB', 'Labourer', 'F'], ['DRV', 'Driver', 'E'],
      ['OPR', 'Equipment Operator', 'E'], ['HRO', 'HR Officer', 'C'], ['ACC', 'Accountant', 'C'], ['ITS', 'IT Support Engineer', 'C'], ['ADMO', 'Admin Officer', 'C'], ['SEC', 'Secretary', 'D'],
    ];
    const desig: Record<string, string> = {};
    for (const [code, title, grade] of designations) {
      const r = await c.query(`INSERT INTO designations(code, title, grade) VALUES ($1,$2,$3) ON CONFLICT (code) DO UPDATE SET title = EXCLUDED.title RETURNING id`, [code, title, grade]);
      desig[code!] = r.rows[0].id;
    }
    const projects = [['C31', 'Residential Tower C31', 'CC-C31'], ['C42', 'Commercial Complex C42', 'CC-C42'], ['C55', 'Villa Compound C55', 'CC-C55'], ['HO', 'Head Office', 'CC-HO']];
    const proj: Record<string, string> = {};
    for (const [code, name, ccc] of projects) {
      const r = await c.query(`INSERT INTO projects(code, name, cost_center_id) VALUES ($1,$2,$3) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [code, name, cc[ccc!]]);
      proj[code!] = r.rows[0].id;
    }
    const sites = [
      ['HO', 'Head Office — Dubai', 'OFFICE', 'HO', 'Dubai'], ['C31-SITE', 'C31 Site — Dubai South', 'SITE', 'C31', 'Dubai'], ['C31-CAMP', 'C31 Labour Camp', 'CAMP', 'C31', 'Dubai'],
      ['C42-SITE', 'C42 Site — Sharjah', 'SITE', 'C42', 'Sharjah'], ['C55-SITE', 'C55 Site — Abu Dhabi', 'SITE', 'C55', 'Abu Dhabi'], ['WH-JA', 'Warehouse — Jebel Ali', 'WAREHOUSE', 'HO', 'Dubai'],
    ];
    const site: Record<string, string> = {};
    for (const [code, name, type, p, emirate] of sites) {
      const r = await c.query(
        `INSERT INTO sites(code, name, site_type, project_id, emirate) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [code, name, type, proj[p!], emirate],
      );
      site[code!] = r.rows[0].id;
    }
    log('organization seeded');

    // ── Holidays (2026 examples — dates for religious holidays REQUIRE annual confirmation) ──
    const holidays = [['2026-01-01', 'New Year'], ['2026-03-20', 'Eid Al Fitr (expected)'], ['2026-03-21', 'Eid Al Fitr holiday'], ['2026-03-22', 'Eid Al Fitr holiday'], ['2026-05-27', 'Eid Al Adha (expected)'], ['2026-12-02', 'UAE National Day'], ['2026-12-03', 'UAE National Day holiday']];
    for (const [d, name] of holidays) {
      await c.query(`INSERT INTO holidays(holiday_date, name) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [d, name]);
    }

    // ── Shifts & work patterns ──────────────────────────────────────────────
    const shiftRows = [
      // code, name, start, end, required, break, grace, half-day threshold
      ['SITE-DAY', 'Site Day Shift', '06:00', '17:00', 480, 60, 15, 240],
      ['SITE-NIGHT', 'Site Night Shift', '18:00', '05:00', 480, 60, 15, 240],
      ['OFFICE', 'Office Hours', '08:30', '17:30', 480, 60, 15, 240],
      ['CAMP-SEC', 'Camp Security 12h', '07:00', '19:00', 660, 60, 10, 330],
    ];
    const shift: Record<string, string> = {};
    for (const [code, name, st, en, req, brk, grace, half] of shiftRows) {
      const r = await c.query(
        `INSERT INTO shifts(code, name, start_time, end_time, required_minutes, break_minutes, grace_in_minutes, half_day_threshold_minutes, ot_max_minutes_per_day)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,240) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [code, name, st, en, req, brk, grace, half],
      );
      shift[code as string] = r.rows[0].id;
    }
    const wpSite = await c.query(
      `INSERT INTO work_patterns(code, name, week_offs, default_shift_id) VALUES ('SITE-6D','Site 6-day week (Fri off)', '{5}', $1)
       ON CONFLICT (code) DO UPDATE SET default_shift_id = EXCLUDED.default_shift_id RETURNING id`, [shift['SITE-DAY']]);
    const wpOffice = await c.query(
      `INSERT INTO work_patterns(code, name, week_offs, default_shift_id) VALUES ('OFFICE-5D','Office 5-day week (Sat/Sun off)', '{6,0}', $1)
       ON CONFLICT (code) DO UPDATE SET default_shift_id = EXCLUDED.default_shift_id RETURNING id`, [shift['OFFICE']]);
    // Site-level default assignments
    for (const [sc, wp] of [['HO', wpOffice.rows[0].id], ['C31-SITE', wpSite.rows[0].id], ['C31-CAMP', wpSite.rows[0].id], ['C42-SITE', wpSite.rows[0].id], ['C55-SITE', wpSite.rows[0].id], ['WH-JA', wpSite.rows[0].id]]) {
      const exists = await c.query(`SELECT 1 FROM shift_assignments WHERE site_id = $1 AND employee_id IS NULL`, [site[sc as string]]);
      if (exists.rowCount === 0) {
        await c.query(`INSERT INTO shift_assignments(site_id, work_pattern_id, effective_from) VALUES ($1,$2,'2026-01-01')`, [site[sc as string], wp]);
      }
    }
    log('shifts seeded');

    // ── Salary components & payroll policy ──────────────────────────────────
    const comps = [
      ['BASIC', 'Basic Salary', 'EARNING', 'FIXED', true, 10], ['HOUSING', 'Housing Allowance', 'EARNING', 'FIXED', true, 20], ['TRANSPORT', 'Transport Allowance', 'EARNING', 'FIXED', true, 30],
      ['FOOD', 'Food Allowance', 'EARNING', 'FIXED', true, 40], ['COMM', 'Communication Allowance', 'EARNING', 'FIXED', true, 50], ['OTHER_ALW', 'Other Allowance', 'EARNING', 'FIXED', true, 60],
      ['OT', 'Overtime', 'EARNING', 'FORMULA', false, 100], ['OT_WEEKEND', 'Weekend Overtime', 'EARNING', 'FORMULA', false, 101], ['OT_HOLIDAY', 'Holiday Overtime', 'EARNING', 'FORMULA', false, 102],
      ['BONUS', 'Bonus', 'EARNING', 'FIXED', false, 110], ['COMMISSION', 'Commission', 'EARNING', 'FIXED', false, 120], ['ADJ_EARN', 'Earning Adjustment', 'EARNING', 'FIXED', false, 190],
      ['UNPAID_LEAVE', 'Unpaid Leave', 'DEDUCTION', 'FORMULA', false, 200], ['ABSENCE', 'Absence', 'DEDUCTION', 'FORMULA', false, 210], ['LATE', 'Late Deduction', 'DEDUCTION', 'FORMULA', false, 220],
      ['EARLY_LEAVE', 'Early Leave Deduction', 'DEDUCTION', 'FORMULA', false, 230], ['LOAN', 'Loan Repayment', 'DEDUCTION', 'FIXED', false, 240], ['ADVANCE', 'Salary Advance', 'DEDUCTION', 'FIXED', false, 250],
      ['OTHER_DED', 'Other Deduction', 'DEDUCTION', 'FIXED', false, 290],
    ];
    for (const [code, name, kind, method, fixed, order] of comps) {
      await c.query(
        `INSERT INTO salary_components(code, name, kind, calc_method, is_fixed_pay, sort_order) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name`, [code, name, kind, method, fixed, order],
      );
    }
    // Company payroll policy v1. Values are COMPANY POLICY examples, NOT legal advice. Statutory items flagged for review.
    const policy = {
      daysInMonthDivisor: 30,
      hoursPerDay: 8,
      rateBase: 'GROSS',               // GROSS | BASIC — which salary the daily/hourly rates derive from (company policy; REQUIRES HR/LEGAL CONFIRMATION)
      overtime: { NORMAL: 1.25, WEEK_OFF: 1.5, PUBLIC_HOLIDAY: 1.5 },   // multipliers: REQUIRES HR/LEGAL CONFIRMATION against UAE Labour Law
      lateDeduction: { enabled: true, perMinute: true, graceMinutesPerMonth: 60 },
      earlyLeaveDeduction: { enabled: true, perMinute: true },
      absenceDeductionDays: 1,
      rounding: 2,
      formulas: {
        DAILY_RATE: 'rate_base / days_in_month_divisor',
        HOURLY_RATE: 'daily_rate / hours_per_day',
        OT: 'hourly_rate * ot_hours * ot_multiplier_normal',
        OT_WEEKEND: 'hourly_rate * weekend_ot_hours * ot_multiplier_week_off',
        OT_HOLIDAY: 'hourly_rate * holiday_ot_hours * ot_multiplier_public_holiday',
        UNPAID_LEAVE: 'daily_rate * unpaid_leave_days',
        ABSENCE: 'daily_rate * absent_days * absence_deduction_days',
        LATE: '(hourly_rate / 60) * max(0, late_minutes - late_grace_minutes_per_month)',
        EARLY_LEAVE: '(hourly_rate / 60) * early_leave_minutes',
      },
    };
    await c.query(
      `INSERT INTO payroll_policies(code, version, name, effective_from, is_statutory, config, notes) VALUES ('DEFAULT', 1, 'Default company payroll policy', '2026-01-01', false, $1, $2)
       ON CONFLICT (code, version) DO UPDATE SET config = EXCLUDED.config`,
      [JSON.stringify(policy), 'Example company policy. OT multipliers and rate base REQUIRE HR/LEGAL CONFIRMATION before production.'],
    );

    // ── Leave types & policies ──────────────────────────────────────────────
    const leaveTypes = [
      ['ANNUAL', 'Annual Leave', true, 30, 'MONTHLY', true], ['SICK', 'Sick Leave', true, 15, 'YEARLY_UPFRONT', true], ['UNPAID', 'Unpaid Leave', false, 0, 'NONE', false],
      ['EMERGENCY', 'Emergency Leave', true, 3, 'YEARLY_UPFRONT', false], ['MATERNITY', 'Maternity Leave', true, 60, 'NONE', true], ['PATERNITY', 'Paternity Leave', true, 5, 'NONE', true],
      ['COMPASSIONATE', 'Compassionate Leave', true, 5, 'NONE', true], ['OTHER', 'Other Leave', true, 0, 'NONE', false],
    ];
    for (const [code, name, paid, ent, accrual, statutory] of leaveTypes) {
      const lt = await c.query(`INSERT INTO leave_types(code, name, is_paid) VALUES ($1,$2,$3) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [code, name, paid]);
      await c.query(
        `INSERT INTO leave_policies(leave_type_id, code, name, annual_entitlement_days, accrual_method, is_statutory, max_carry_forward_days)
         VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $2 = 'ANNUAL-DEFAULT' THEN 10 ELSE 0 END) ON CONFLICT (code) DO NOTHING`,
        [lt.rows[0].id, `${code}-DEFAULT`, `${name} — default policy`, ent, accrual, statutory],
      );
    }
    // Overtime rules (company policy examples — multipliers REQUIRE HR/LEGAL CONFIRMATION)
    for (const [code, name, kind, mult] of [['OT-NORMAL', 'Normal day OT', 'NORMAL', 1.25], ['OT-WEEKOFF', 'Week-off OT', 'WEEK_OFF', 1.5], ['OT-HOLIDAY', 'Public holiday OT', 'PUBLIC_HOLIDAY', 1.5]]) {
      await c.query(
        `INSERT INTO overtime_rules(code, name, day_kind, multiplier, max_minutes_per_day, requires_hr_approval_over_minutes) VALUES ($1,$2,$3,$4,240,120) ON CONFLICT (code) DO NOTHING`,
        [code, name, kind, mult],
      );
    }
    log('payroll & leave policies seeded');

    // ── Checklist templates ─────────────────────────────────────────────────
    const onboarding = [
      { key: 'hr.profile', title: 'Employee profile completed', group: 'HR', ownerRole: 'HR_ADMIN' }, { key: 'hr.contract', title: 'Contract signed & uploaded', group: 'HR', ownerRole: 'HR_ADMIN' },
      { key: 'hr.documents', title: 'Documents collected (EID, passport, visa)', group: 'HR', ownerRole: 'HR_ADMIN' }, { key: 'hr.salary', title: 'Salary structure defined', group: 'HR', ownerRole: 'HR_MANAGER' },
      { key: 'it.email', title: 'Email account created', group: 'IT', ownerRole: 'IT_ADMIN', condition: 'office_staff' }, { key: 'it.m365', title: 'Microsoft 365 licence assigned', group: 'IT', ownerRole: 'IT_ADMIN', condition: 'office_staff' },
      { key: 'it.laptop', title: 'Laptop issued', group: 'IT', ownerRole: 'IT_ADMIN', condition: 'office_staff' }, { key: 'it.sim', title: 'SIM issued', group: 'IT', ownerRole: 'IT_ADMIN', required: false },
      { key: 'it.access', title: 'System access granted', group: 'IT', ownerRole: 'IT_ADMIN' }, { key: 'it.biometric', title: 'Biometric enrolment on site device', group: 'IT', ownerRole: 'IT_ADMIN' },
      { key: 'fin.bank', title: 'Bank details verified', group: 'FINANCE', ownerRole: 'FINANCE' }, { key: 'fin.payroll', title: 'Payroll setup completed', group: 'FINANCE', ownerRole: 'PAYROLL_OFFICER' },
      { key: 'adm.accommodation', title: 'Accommodation allocated', group: 'ADMIN', ownerRole: 'HR_ADMIN', required: false }, { key: 'adm.idcard', title: 'ID / access card issued', group: 'ADMIN', ownerRole: 'HR_ADMIN' },
    ];
    const clearance = [
      { key: 'mgr.handover', title: 'Work handover completed', group: 'MANAGER', ownerRole: 'DEPARTMENT_MANAGER' }, { key: 'proj.handover', title: 'Project responsibilities handed over', group: 'PROJECT', ownerRole: 'PROJECT_MANAGER' },
      { key: 'it.laptop', title: 'Laptop returned', group: 'IT', ownerRole: 'IT_ADMIN' }, { key: 'it.phone', title: 'Phone returned', group: 'IT', ownerRole: 'IT_ADMIN' }, { key: 'it.sim', title: 'SIM returned', group: 'IT', ownerRole: 'IT_ADMIN' },
      { key: 'it.email', title: 'Email disabled', group: 'IT', ownerRole: 'IT_ADMIN' }, { key: 'it.m365', title: 'M365 licence removed', group: 'IT', ownerRole: 'IT_ADMIN' }, { key: 'it.access', title: 'System access removed', group: 'IT', ownerRole: 'IT_ADMIN' },
      { key: 'it.biometric', title: 'Biometric user disabled on devices', group: 'IT', ownerRole: 'IT_ADMIN' }, { key: 'adm.assets', title: 'Company assets cleared', group: 'ADMIN', ownerRole: 'HR_ADMIN' },
      { key: 'adm.accommodation', title: 'Accommodation vacated', group: 'ADMIN', ownerRole: 'HR_ADMIN' }, { key: 'fin.loans', title: 'Loans / advances settled', group: 'FINANCE', ownerRole: 'FINANCE' },
      { key: 'hr.leave', title: 'Leave balance confirmed', group: 'HR', ownerRole: 'HR_ADMIN' }, { key: 'hr.visa', title: 'Visa cancellation initiated', group: 'HR', ownerRole: 'HR_ADMIN' },
      { key: 'fin.settlement', title: 'Final settlement calculated & approved', group: 'FINANCE', ownerRole: 'FINANCE_MANAGER' },
    ];
    await c.query(`INSERT INTO checklist_templates(code, name, items) VALUES ('ONBOARDING','Onboarding', $1) ON CONFLICT (code) DO UPDATE SET items = EXCLUDED.items`, [JSON.stringify(onboarding)]);
    await c.query(`INSERT INTO checklist_templates(code, name, items) VALUES ('CLEARANCE','Exit Clearance', $1) ON CONFLICT (code) DO UPDATE SET items = EXCLUDED.items`, [JSON.stringify(clearance)]);

    // ── Workflow definitions ────────────────────────────────────────────────
    const workflows = [
      { code: 'OVERTIME_APPROVAL', name: 'Overtime approval', entity: 'overtime_request', trigger: { event: 'overtime_request.created' }, conditions: [],
        steps: [{ key: 'manager', approverType: 'MANAGER' }, { key: 'hr', approverType: 'ROLE', roleCode: 'HR_ADMIN', condition: { field: 'requested_minutes', op: 'gt', value: 120 } }],
        actions: [{ type: 'set_status', onApprove: 'APPROVED', onReject: 'REJECTED' }] },
      { code: 'LEAVE_APPROVAL', name: 'Leave approval', entity: 'leave_request', trigger: { event: 'leave_request.created' }, conditions: [],
        steps: [{ key: 'manager', approverType: 'MANAGER' }, { key: 'hr', approverType: 'ROLE', roleCode: 'HR_ADMIN' }],
        actions: [{ type: 'set_status', onApprove: 'APPROVED', onReject: 'REJECTED' }] },
      { code: 'SALARY_CHANGE', name: 'Salary change', entity: 'employee_salary_structure', trigger: { event: 'salary_structure.proposed' }, conditions: [],
        steps: [{ key: 'hr', approverType: 'ROLE', roleCode: 'HR_MANAGER' }, { key: 'finance', approverType: 'ROLE', roleCode: 'FINANCE_MANAGER' }, { key: 'management', approverType: 'ROLE', roleCode: 'MANAGEMENT' }],
        actions: [{ type: 'set_status', onApprove: 'APPROVED', onReject: 'REJECTED' }] },
      { code: 'RESIGNATION', name: 'Resignation & clearance', entity: 'employee', trigger: { event: 'employee.resigned' }, conditions: [],
        steps: [{ key: 'manager', approverType: 'MANAGER' }, { key: 'hr', approverType: 'ROLE', roleCode: 'HR_MANAGER' }, { key: 'it', approverType: 'ROLE', roleCode: 'IT_ADMIN' }, { key: 'finance', approverType: 'ROLE', roleCode: 'FINANCE' }, { key: 'admin', approverType: 'ROLE', roleCode: 'HR_ADMIN' }],
        actions: [{ type: 'transition_employee', onApprove: 'FINAL_SETTLEMENT' }] },
      { code: 'ATTENDANCE_CORRECTION', name: 'Attendance correction', entity: 'attendance_correction', trigger: { event: 'attendance_correction.created' }, conditions: [],
        steps: [{ key: 'manager', approverType: 'MANAGER' }, { key: 'hr', approverType: 'ROLE', roleCode: 'HR_ADMIN' }],
        actions: [{ type: 'set_status', onApprove: 'APPROVED', onReject: 'REJECTED' }] },
    ];
    for (const w of workflows) {
      await c.query(
        `INSERT INTO workflow_definitions(code, version, name, entity_type, trigger, conditions, steps, actions) VALUES ($1,1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (code, version) DO UPDATE SET steps = EXCLUDED.steps, actions = EXCLUDED.actions`,
        [w.code, w.name, w.entity, JSON.stringify(w.trigger), JSON.stringify(w.conditions), JSON.stringify(w.steps), JSON.stringify(w.actions)],
      );
    }
    log('workflows & checklists seeded');

    // ── Devices ─────────────────────────────────────────────────────────────
    const devices = [['ARGO-HO-01', 'HO Reception', 'HO'], ['ARGO-C31-01', 'C31 Main Gate', 'C31-SITE'], ['ARGO-C31-02', 'C31 Camp Entrance', 'C31-CAMP'], ['ARGO-C42-01', 'C42 Main Gate', 'C42-SITE'], ['ARGO-C55-01', 'C55 Main Gate', 'C55-SITE'], ['ARGO-WH-01', 'Warehouse Gate', 'WH-JA']];
    const dev: Record<string, string> = {};
    for (const [code, name, sc] of devices) {
      const r = await c.query(
        `INSERT INTO devices(device_code, name, model, site_id, status) VALUES ($1,$2,'ARGO FACE',$3,'UNKNOWN') ON CONFLICT (device_code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [code, name, site[sc!]],
      );
      dev[code!] = r.rows[0].id;
      await c.query(`INSERT INTO device_sites(device_id, site_id, from_date) VALUES ($1,$2,'2026-01-01') ON CONFLICT DO NOTHING`, [dev[code!], site[sc!]]);
    }
    await c.query(`INSERT INTO integration_connections(code, provider, status, config) VALUES ('MATRIX_DEVICE_GATEWAY','MATRIX','ACTIVE','{"mode":"webhook"}') ON CONFLICT (code) DO NOTHING`);
    await c.query(`INSERT INTO integration_connections(code, provider, status, config) VALUES ('MATRIX_VYOM','MATRIX','DISABLED','{"mode":"poll","note":"REQUIRES VENDOR CONFIRMATION"}') ON CONFLICT (code) DO NOTHING`);
    log('devices seeded');

    // ── Employees (synthetic) ───────────────────────────────────────────────
    const existing = await c.query('SELECT count(*)::int AS n FROM employees');
    if (existing.rows[0].n === 0) {
      const plan: { count: number; siteCode: string; projCode: string; deptCodes: string[]; desigCodes: string[]; office: boolean; basic: [number, number] }[] = [
        { count: 18, siteCode: 'HO', projCode: 'HO', deptCodes: ['MGMT', 'HR', 'FIN', 'IT', 'ADM', 'PROC'], desigCodes: ['HRO', 'ACC', 'ITS', 'ADMO', 'SEC', 'PM'], office: true, basic: [6000, 18000] },
        { count: 70, siteCode: 'C31-SITE', projCode: 'C31', deptCodes: ['CIVIL', 'MEP', 'FINISH', 'ENG', 'QHSE'], desigCodes: ['SE', 'FM', 'CH', 'MAS', 'CARP', 'STF', 'ELEC', 'PLUM', 'HELP', 'LAB'], office: false, basic: [1200, 6000] },
        { count: 45, siteCode: 'C42-SITE', projCode: 'C42', deptCodes: ['CIVIL', 'MEP', 'ENG'], desigCodes: ['SE', 'FM', 'MAS', 'CARP', 'STF', 'HELP', 'LAB'], office: false, basic: [1200, 6000] },
        { count: 30, siteCode: 'C55-SITE', projCode: 'C55', deptCodes: ['CIVIL', 'FINISH', 'ENG'], desigCodes: ['SE', 'FM', 'MAS', 'CARP', 'HELP', 'LAB'], office: false, basic: [1200, 6000] },
        { count: 12, siteCode: 'WH-JA', projCode: 'HO', deptCodes: ['LOG', 'PLANT'], desigCodes: ['DRV', 'OPR', 'HELP'], office: false, basic: [1500, 4000] },
      ];
      const compIds = (await c.query(`SELECT id, code FROM salary_components`)).rows.reduce((m: Record<string, string>, r: { id: string; code: string }) => ((m[r.code] = r.id), m), {});
      let seq = 1;
      let managerOfSite: Record<string, string> = {};
      for (const group of plan) {
        for (let i = 0; i < group.count; i++, seq++) {
          const employeeNo = `BP-26-${pad(seq)}`;
          const first = pick(FIRST, seq * 7 + i);
          const last = pick(LAST, seq * 3 + i);
          const basic = group.basic[0] + ((seq * 137) % (group.basic[1] - group.basic[0]));
          const housing = Math.round(basic * 0.25);
          const transport = group.office ? 800 : 300;
          const food = group.office ? 0 : 300;
          const gross = basic + housing + transport + food;
          const joining = new Date(Date.UTC(2023 + (seq % 3), seq % 12, 1 + (seq % 27)));
          const joiningStr = joining.toISOString().slice(0, 10);
          const onProbation = joining > new Date('2026-04-01');
          const r = await c.query(
            `INSERT INTO employees(employee_no, matrix_user_id, first_name, last_name, gender, date_of_birth, nationality, mobile, work_email, status, employment_type, joining_date,
               probation_status, probation_end_date, department_id, designation_id, site_id, project_id, cost_center_id, manager_employee_id, is_office_staff, contract_start_date, contract_end_date)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'FULL_TIME',$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$11,$21) RETURNING id`,
            [
              employeeNo, String(seq), first, last, seq % 9 === 0 ? 'FEMALE' : 'MALE', `19${70 + (seq % 30)}-0${1 + (seq % 9)}-1${seq % 9}`, pick(NATIONALITIES, seq),
              `+9715${pad(seq, 8)}`, group.office ? `${first.toLowerCase()}.${last.toLowerCase().replace(/\s/g, '')}${seq}@burtplace.local` : null,
              onProbation ? 'PROBATION' : 'ACTIVE', joiningStr, onProbation ? 'ON_PROBATION' : 'CONFIRMED',
              onProbation ? new Date(joining.getTime() + 180 * 864e5).toISOString().slice(0, 10) : null,
              dept[pick(group.deptCodes, seq)], desig[pick(group.desigCodes, seq)], site[group.siteCode], proj[group.projCode],
              (await c.query('SELECT cost_center_id FROM projects WHERE id = $1', [proj[group.projCode]])).rows[0].cost_center_id,
              managerOfSite[group.siteCode] ?? null, group.office, new Date(joining.getTime() + 730 * 864e5).toISOString().slice(0, 10),
            ],
          );
          const id: string = r.rows[0].id;
          if (!managerOfSite[group.siteCode]) managerOfSite[group.siteCode] = id;
          await c.query(`INSERT INTO employee_status_history(employee_id, from_status, to_status, effective_date, reason) VALUES ($1, NULL, $2, $3, 'seed')`, [id, onProbation ? 'PROBATION' : 'ACTIVE', joiningStr]);
          await c.query(
            `INSERT INTO employment_history(employee_id, effective_from, change_type, department_id, designation_id, site_id, project_id, employment_type) VALUES ($1,$2,'JOIN',$3,$4,$5,$6,'FULL_TIME')`,
            [id, joiningStr, dept[pick(group.deptCodes, seq)], desig[pick(group.desigCodes, seq)], site[group.siteCode], proj[group.projCode]],
          );
          await c.query(`INSERT INTO biometric_mappings(employee_id, provider, external_user_id, enrolled_devices, enrolled_at) VALUES ($1,'MATRIX',$2,$3, now())`, [id, String(seq), [dev[devices.find((d) => d[2] === group.siteCode)![0]!]]]);
          const ss = await c.query(
            `INSERT INTO employee_salary_structures(employee_id, version, effective_from, basic_salary, gross_salary, reason) VALUES ($1,1,$2,$3,$4,'Initial') RETURNING id`,
            [id, joiningStr, basic, gross],
          );
          for (const [code, amt] of [['BASIC', basic], ['HOUSING', housing], ['TRANSPORT', transport], ['FOOD', food]]) {
            if ((amt as number) > 0) await c.query(`INSERT INTO employee_salary_lines(salary_structure_id, component_id, amount) VALUES ($1,$2,$3)`, [ss.rows[0].id, compIds[code as string], amt]);
          }
          // documents with staggered expiry (some expiring soon for dashboard realism)
          const exp = new Date(Date.UTC(2026, 8, 14 + ((seq * 11) % 400)));
          await c.query(`INSERT INTO employee_documents(employee_id, document_type, document_number, issue_date, expiry_date, status) VALUES ($1,'EMIRATES_ID',$2,'2024-01-01',$3,'VALID')`, [id, `784-19${70 + (seq % 30)}-${pad(seq, 7)}-1`, exp.toISOString().slice(0, 10)]);
          await c.query(`INSERT INTO employee_documents(employee_id, document_type, document_number, issue_date, expiry_date, status) VALUES ($1,'PASSPORT',$2,'2022-01-01',$3,'VALID')`, [id, `P${pad(seq, 8)}`, new Date(exp.getTime() + 500 * 864e5).toISOString().slice(0, 10)]);
          await c.query(`INSERT INTO employee_documents(employee_id, document_type, document_number, issue_date, expiry_date, status) VALUES ($1,'VISA',$2,'2024-06-01',$3,'VALID')`, [id, `V${pad(seq, 9)}`, new Date(exp.getTime() - 60 * 864e5).toISOString().slice(0, 10)]);
          await c.query(`INSERT INTO leave_balances(employee_id, leave_type_id, period_year, opening_days, accrued_days) SELECT $1, id, 2026, 0, 17.5 FROM leave_types WHERE code = 'ANNUAL'`, [id]);
          await c.query(`INSERT INTO leave_balances(employee_id, leave_type_id, period_year, opening_days, accrued_days) SELECT $1, id, 2026, 15, 0 FROM leave_types WHERE code = 'SICK'`, [id]);
        }
      }
      // Link the sample employee login + PM login to employees
      await c.query(`UPDATE employees SET user_id = $1 WHERE employee_no = 'BP-26-020'`, [users['employee@burtplace.local']]);
      await c.query(`UPDATE employees SET user_id = $1 WHERE employee_no = 'BP-26-019'`, [users['pm.c31@burtplace.local']]);
      await c.query(`UPDATE projects SET manager_employee_id = (SELECT id FROM employees WHERE employee_no = 'BP-26-019') WHERE code = 'C31'`);
      log(`employees seeded (${seq - 1})`);
    } else {
      log('employees already present — skipped');
    }

    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}
