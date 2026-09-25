/**
 * Seed for Compensation & Salary Management. Idempotent.
 * EVERY value below is an EXAMPLE for development — bands, thresholds, merit percentages, promotion rules, budgets and
 * approval chains are company policy and REQUIRE HR / FINANCE CONFIRMATION before production use.
 */
import type pg from 'pg';

/** Default compensation policy (stored in app_settings `compensation.policy`, versioned with history). */
export const EXAMPLE_COMPENSATION_POLICY = {
  signedOff: false,
  bandBasis: 'BASIC',                 // BASIC | GROSS — which salary is compared against the band
  statusThresholds: {
    ranges: [
      { code: 'NORMAL', label: 'Normal', color: 'GREEN', fromPct: 0, toPct: 80 },
      { code: 'WATCH', label: 'Watch', color: 'YELLOW', fromPct: 80, toPct: 90 },
      { code: 'NEAR_CEILING', label: 'Near ceiling', color: 'ORANGE', fromPct: 90, toPct: 100 },
    ],
    belowMin: { code: 'BELOW_MIN', label: 'Below minimum', color: 'BLUE' },
    atMax: { code: 'AT_MAX', label: 'At maximum', color: 'RED' },
    aboveMax: { code: 'ABOVE_MAX', label: 'Above maximum', color: 'RED' },
    noBand: { code: 'NO_BAND', label: 'No salary band', color: 'GREY' },
  },
  ceilingActions: ['CAP_AT_MAX', 'REQUEST_EXCEPTION', 'CANCEL', 'CHANGE_GRADE'],
  annualizationMonths: 12,
  budgetEnforcement: 'BLOCK',          // BLOCK | WARN | OFF — approving beyond the approved budget
  segregationOfDuties: true,           // the requester may not approve their own compensation request
  reviewDueMonths: 12,                 // "due for salary review" when the last increase is older than this
  maxIncreasePctWithoutOverride: 25,   // any single change above this % needs compensation:override + justification
  directSalaryEntry: 'ALLOWED',        // ALLOWED | INITIAL_ONLY — POST /employees/:id/salary outside the compensation workflow
};

export async function seedCompensation(c: pg.PoolClient, log: (m: string) => void): Promise<void> {
  // Bands: one ACTIVE band per grade that has none yet, from the grade's current min/mid/max
  await c.query(`INSERT INTO salary_bands(grade_id, min_salary, mid_salary, max_salary, currency, effective_from, status, notes)
    SELECT g.id, g.min_salary, coalesce(g.mid_salary, round((g.min_salary + g.max_salary) / 2, 2)), g.max_salary, g.currency, DATE '2026-01-01', 'ACTIVE', 'Development example — REQUIRES HR CONFIRMATION'
    FROM grades g WHERE g.min_salary IS NOT NULL AND g.max_salary IS NOT NULL AND NOT EXISTS (SELECT 1 FROM salary_bands b WHERE b.grade_id = g.id AND b.deleted_at IS NULL)`);
  await c.query(`UPDATE grades SET description = coalesce(description, 'Grade ' || code) WHERE description IS NULL`);

  // Performance rating levels over the 1–5 review scale
  const levels: [string, string, number, number][] = [['EXCELLENT', 'Excellent', 4.5, 5], ['VERY_GOOD', 'Very good', 3.75, 4.49], ['GOOD', 'Good', 3, 3.74], ['AVERAGE', 'Average', 2, 2.99], ['POOR', 'Poor', 0, 1.99]];
  for (const [i, [code, label, mn, mx]] of levels.entries()) await c.query(`INSERT INTO performance_rating_levels(code, label, min_score, max_score, sort_order) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (code) DO NOTHING`, [code, label, mn, mx, (i + 1) * 10]);

  // Default merit matrix (rating × compa-ratio)
  if (!(await c.query(`SELECT 1 FROM merit_matrices WHERE is_default AND deleted_at IS NULL`)).rowCount) {
    const m = await c.query(`INSERT INTO merit_matrices(name, fiscal_year, effective_from, status, is_default, notes) VALUES ('Standard merit matrix', 2027, '2027-01-01', 'ACTIVE', true, 'Development example — REQUIRES HR CONFIRMATION') RETURNING id`);
    const cells: [string, number | null, number | null, number, number][] = [
      ['EXCELLENT', null, 90, 10, 12], ['EXCELLENT', 90, 105, 8, 10], ['EXCELLENT', 105, null, 5, 7],
      ['VERY_GOOD', null, 90, 8, 10], ['VERY_GOOD', 90, 105, 6, 8], ['VERY_GOOD', 105, null, 4, 5],
      ['GOOD', null, 90, 6, 7], ['GOOD', 90, 105, 4, 5], ['GOOD', 105, null, 2, 3],
      ['AVERAGE', null, 90, 3, 4], ['AVERAGE', 90, null, 1.5, 2],
      ['POOR', null, null, 0, 0],
    ];
    for (const [r, mn, mx, rec, max] of cells) await c.query(`INSERT INTO merit_matrix_cells(matrix_id, rating_code, min_compa, max_compa, recommended_pct, max_pct) VALUES ($1,$2,$3,$4,$5,$6)`, [m.rows[0].id, r, mn, mx, rec, max]);
  }

  // Promotion rules
  if (!(await c.query(`SELECT 1 FROM promotion_salary_rules`)).rowCount) {
    await c.query(`INSERT INTO promotion_salary_rules(name, method, value, min_increase_pct, max_increase_pct, cap_at_max, priority, notes) VALUES ('Default promotion rule', 'GREATER_OF_PERCENT_OR_MINIMUM', 10, 5, 25, true, 100, 'Development example — REQUIRES HR CONFIRMATION')`);
  }
  // Compression rules
  if (!(await c.query(`SELECT 1 FROM salary_compression_rules`)).rowCount) {
    await c.query(`INSERT INTO salary_compression_rules(name, scope, min_difference_pct, compare) VALUES ('Adjacent grades (average salary)', 'GRADE_SEQUENCE', 5, 'AVERAGE')`);
    await c.query(`INSERT INTO salary_compression_rules(name, scope, lower_designation_id, upper_designation_id, min_difference_amount, min_difference_pct, compare)
      SELECT 'Charge Hand → Foreman', 'DESIGNATION_PAIR', l.id, u.id, 300, 5, 'AVERAGE' FROM designations l, designations u WHERE l.code = 'CH' AND u.code = 'FM'`);
    await c.query(`INSERT INTO salary_compression_rules(name, scope, lower_designation_id, upper_designation_id, min_difference_amount, min_difference_pct, compare)
      SELECT 'Site Engineer → Construction Manager', 'DESIGNATION_PAIR', l.id, u.id, 1000, 10, 'AVERAGE' FROM designations l, designations u WHERE l.code = 'SE' AND u.code = 'CM'`);
  }

  // Policy (thresholds etc.) — only when not configured yet
  await c.query(`INSERT INTO app_settings(key, value) VALUES ('compensation.policy', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(EXAMPLE_COMPENSATION_POLICY)]);

  // Budgets FY2027
  const budgets: [string, string, number][] = [['FY2027 compensation budget', 'ANNUAL', 5_000_000], ['FY2027 increment budget', 'INCREMENT', 3_500_000], ['FY2027 promotion budget', 'PROMOTION', 1_000_000], ['FY2027 adjustments budget', 'ADJUSTMENT', 500_000]];
  for (const [name, type, amt] of budgets) await c.query(`INSERT INTO compensation_budgets(name, fiscal_year, budget_type, scope_type, amount, notes) SELECT $1, 2027, $2, 'COMPANY', $3, 'Development example — REQUIRES FINANCE CONFIRMATION' WHERE NOT EXISTS (SELECT 1 FROM compensation_budgets WHERE fiscal_year = 2027 AND budget_type = $2 AND scope_type = 'COMPANY' AND deleted_at IS NULL)`, [name, type, amt]);

  // Approval chains (configurable; re-version via POST /workflows/definitions). statusOnApprove drives the compensation status.
  const hr = { key: 'hr_manager', approverType: 'ROLE', roleCode: 'HR_MANAGER', statusOnApprove: 'HR_APPROVED' };
  const dept = { key: 'department_manager', approverType: 'MANAGER', statusOnApprove: 'UNDER_REVIEW' };
  const fin = { key: 'finance', approverType: 'ROLE', roleCode: 'FINANCE_MANAGER', statusOnApprove: 'FINANCE_APPROVED' };
  const mgmt = { key: 'management', approverType: 'ROLE', roleCode: 'MANAGEMENT', statusOnApprove: 'MANAGEMENT_APPROVED' };
  const mgmtIfException = { ...mgmt, condition: { field: 'requiresException', op: 'eq', value: true } };
  const wf: [string, string, string, object[]][] = [
    ['COMP_ANNUAL_INCREMENT', 'Annual increment (individual)', 'hr_request', [hr, fin, mgmtIfException]],
    ['COMP_MERIT_INCREASE', 'Merit increase', 'hr_request', [hr, dept, fin, mgmt]],
    ['COMP_PROMOTION', 'Promotion', 'hr_request', [hr, dept, fin, mgmt]],
    ['COMP_MARKET_ADJUSTMENT', 'Market adjustment', 'hr_request', [hr, fin, mgmt]],
    ['COMP_SALARY_CORRECTION', 'Salary correction', 'hr_request', [hr, fin]],
    ['COMP_SPECIAL_ADJUSTMENT', 'Special adjustment', 'hr_request', [hr, dept, fin, mgmt]],
    ['COMP_DEMOTION_ADJUSTMENT', 'Demotion adjustment', 'hr_request', [hr, dept, mgmt]],
    ['COMP_GRADE_CHANGE', 'Grade change', 'hr_request', [hr, fin, mgmt]],
    ['COMP_SALARY_REVIEW', 'Annual salary review (whole cycle)', 'salary_review', [hr, fin, mgmt]],
  ];
  for (const [code, name, entity, steps] of wf) {
    await c.query(`INSERT INTO workflow_definitions(code, version, name, entity_type, trigger, conditions, steps, actions) VALUES ($1,1,$2,$3,$4,'[]',$5,'[]') ON CONFLICT (code, version) DO NOTHING`, [code, name, entity, JSON.stringify({ event: `${code.toLowerCase()}.submitted` }), JSON.stringify(steps)]);
  }
  log('compensation configuration seeded (EXAMPLES — REQUIRE HR/FINANCE CONFIRMATION)');
}
