/**
 * Final settlement (end-of-service) calculator.
 *
 * Every rule here is CONFIGURATION taken from the payroll policy (`finalSettlement` block). The engine does not
 * embed statutory values: gratuity bands, caps, service thresholds, encashment basis and notice treatment are
 * supplied by HR/Legal through the policy. A statement is DRAFT until `policy.signedOff === true`.
 */
export interface SettlementPolicy {
  /** Set by HR/Legal once the bands below have been confirmed against UAE Labour Law and the company policy. */
  signedOff: boolean;
  gratuity: {
    /** Salary basis for the daily rate used in gratuity. */
    basis: 'BASIC' | 'GROSS';
    /** Progressive bands by completed years of service: days of basis salary per year of service. */
    bands: { uptoYears: number | null; daysPerYear: number }[];
    /** Minimum completed service (years) before gratuity is payable. */
    minServiceYears: number;
    /** Cap expressed in months of basis salary (null = no cap). */
    capMonths: number | null;
    /** Pro-rate the final partial year. */
    proRata: boolean;
    /** Divisor used to turn a monthly salary into a daily rate. */
    daysInMonthDivisor: number;
  };
  leaveEncashment: { enabled: boolean; basis: 'BASIC' | 'GROSS'; daysInMonthDivisor: number };
  /** Days of unpaid leave are excluded from service length when true. */
  excludeUnpaidLeaveFromService: boolean;
  /** Notice shortfall recovered from the employee (days × daily basis rate) when true. */
  recoverNoticeShortfall: boolean;
}

export interface SettlementInput {
  joiningDate: string;          // YYYY-MM-DD
  lastWorkingDate: string;      // YYYY-MM-DD
  basicSalary: number;
  grossSalary: number;
  unpaidLeaveDays?: number;     // total unpaid leave days during service
  leaveBalanceDays?: number;    // unused annual leave
  noticeShortfallDays?: number; // days of notice not served (recoverable)
  outstandingLoans?: number;    // sum of loan/advance outstanding
  pendingDeductions?: number;   // approved but unapplied deductions
  pendingBonuses?: number;      // approved but unpaid bonuses
  finalPeriodNet?: number;      // net pay of the final (partial) payroll period, if already calculated
  exitType?: 'RESIGNATION' | 'TERMINATION' | 'END_OF_CONTRACT' | 'OTHER';
}

export interface SettlementLine { code: string; label: string; kind: 'EARNING' | 'DEDUCTION'; amount: number; detail: string }
export interface SettlementResult {
  status: 'DRAFT' | 'SIGNED_OFF_POLICY';
  service: { years: number; months: number; days: number; totalDays: number; completedYears: number; fractionalYears: number };
  dailyRate: { gratuity: number; encashment: number };
  lines: SettlementLine[];
  totalEarnings: number;
  totalDeductions: number;
  net: number;
  warnings: string[];
  trace: Record<string, unknown>;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const MS_DAY = 864e5;

export function serviceLength(joining: string, last: string, excludedDays = 0): SettlementResult['service'] {
  const j = new Date(`${joining}T00:00:00Z`), l = new Date(`${last}T00:00:00Z`);
  const totalDays = Math.max(0, Math.round((l.getTime() - j.getTime()) / MS_DAY) + 1 - excludedDays);
  // Calendar-accurate Y/M/D split, treating the last working day as inclusive (end = last + 1 day, exclusive)
  const end = new Date(l.getTime() + MS_DAY);
  let years = end.getUTCFullYear() - j.getUTCFullYear(), months = end.getUTCMonth() - j.getUTCMonth(), days = end.getUTCDate() - j.getUTCDate();
  if (days < 0) { months--; days += new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 0)).getUTCDate(); }
  if (months < 0) { years--; months += 12; }
  if (years < 0) { years = 0; months = 0; days = 0; }
  const fractional = totalDays / 365;
  return { years, months, days, totalDays, completedYears: Math.floor(fractional), fractionalYears: r2(fractional) };
}

export function calculateSettlement(policy: SettlementPolicy, input: SettlementInput): SettlementResult {
  const warnings: string[] = [];
  if (!policy.signedOff) warnings.push('Settlement policy has not been signed off by HR/Legal — figures are indicative only');
  const service = serviceLength(input.joiningDate, input.lastWorkingDate, policy.excludeUnpaidLeaveFromService ? (input.unpaidLeaveDays ?? 0) : 0);
  const basis = (b: 'BASIC' | 'GROSS') => (b === 'BASIC' ? input.basicSalary : input.grossSalary);
  const gDaily = r2(basis(policy.gratuity.basis) / policy.gratuity.daysInMonthDivisor);
  const eDaily = r2(basis(policy.leaveEncashment.basis) / policy.leaveEncashment.daysInMonthDivisor);
  const lines: SettlementLine[] = [];
  const trace: Record<string, unknown> = { service, gratuityDailyRate: gDaily, encashmentDailyRate: eDaily, bands: policy.gratuity.bands };

  // Gratuity: walk the progressive bands over the (possibly fractional) years of service
  let gratuityDays = 0;
  const years = policy.gratuity.proRata ? service.totalDays / 365 : service.completedYears;
  if (years >= policy.gratuity.minServiceYears) {
    let from = 0;
    const bandTrace: unknown[] = [];
    for (const band of policy.gratuity.bands) {
      const to = band.uptoYears ?? Infinity;
      const span = Math.max(0, Math.min(years, to) - from);
      if (span <= 0) { from = to; continue; }
      gratuityDays += span * band.daysPerYear;
      bandTrace.push({ from, to: band.uptoYears, years: r2(span), daysPerYear: band.daysPerYear, days: r2(span * band.daysPerYear) });
      from = to;
      if (years <= to) break;
    }
    trace.gratuityBands = bandTrace;
    let gratuity = r2(gratuityDays * gDaily);
    if (policy.gratuity.capMonths !== null) { const cap = r2(basis(policy.gratuity.basis) * policy.gratuity.capMonths); if (gratuity > cap) { trace.gratuityCapApplied = { cap, before: gratuity }; gratuity = cap; } }
    lines.push({ code: 'GRATUITY', label: 'End of service gratuity', kind: 'EARNING', amount: gratuity, detail: `${r2(gratuityDays)} days × ${gDaily} (${policy.gratuity.basis.toLowerCase()} basis) · ${r2(years)} years` });
  } else {
    lines.push({ code: 'GRATUITY', label: 'End of service gratuity', kind: 'EARNING', amount: 0, detail: `Service ${r2(years)} years is below the ${policy.gratuity.minServiceYears}-year minimum` });
  }

  if (policy.leaveEncashment.enabled && (input.leaveBalanceDays ?? 0) > 0) lines.push({ code: 'LEAVE_ENCASH', label: 'Unused annual leave', kind: 'EARNING', amount: r2((input.leaveBalanceDays ?? 0) * eDaily), detail: `${input.leaveBalanceDays} days × ${eDaily} (${policy.leaveEncashment.basis.toLowerCase()} basis)` });
  if (input.finalPeriodNet !== undefined) lines.push({ code: 'FINAL_SALARY', label: 'Final period salary (net)', kind: 'EARNING', amount: r2(input.finalPeriodNet), detail: 'From the final payroll run' });
  if ((input.pendingBonuses ?? 0) > 0) lines.push({ code: 'BONUS', label: 'Approved unpaid bonuses', kind: 'EARNING', amount: r2(input.pendingBonuses!), detail: 'Approved bonuses not yet paid' });
  if ((input.outstandingLoans ?? 0) > 0) lines.push({ code: 'LOAN', label: 'Outstanding loans & advances', kind: 'DEDUCTION', amount: r2(input.outstandingLoans!), detail: 'Recovered in full from the settlement' });
  if ((input.pendingDeductions ?? 0) > 0) lines.push({ code: 'DEDUCTIONS', label: 'Approved unapplied deductions', kind: 'DEDUCTION', amount: r2(input.pendingDeductions!), detail: 'Penalties, asset damage, other' });
  if (policy.recoverNoticeShortfall && (input.noticeShortfallDays ?? 0) > 0) lines.push({ code: 'NOTICE', label: 'Notice period shortfall', kind: 'DEDUCTION', amount: r2((input.noticeShortfallDays ?? 0) * gDaily), detail: `${input.noticeShortfallDays} days × ${gDaily}` });

  const totalEarnings = r2(lines.filter((l) => l.kind === 'EARNING').reduce((s, l) => s + l.amount, 0));
  const totalDeductions = r2(lines.filter((l) => l.kind === 'DEDUCTION').reduce((s, l) => s + l.amount, 0));
  if (input.exitType === 'TERMINATION') warnings.push('Termination: gratuity forfeiture or reduction, if any, is a legal determination — REQUIRES HR/LEGAL SIGN-OFF');
  return { status: policy.signedOff ? 'SIGNED_OFF_POLICY' : 'DRAFT', service, dailyRate: { gratuity: gDaily, encashment: eDaily }, lines, totalEarnings, totalDeductions, net: r2(totalEarnings - totalDeductions), warnings, trace };
}

/** Placeholder policy shipped with the seed: values are company examples and MUST be confirmed (signedOff=false). */
export const EXAMPLE_SETTLEMENT_POLICY: SettlementPolicy = {
  signedOff: false,
  gratuity: { basis: 'BASIC', bands: [{ uptoYears: 5, daysPerYear: 21 }, { uptoYears: null, daysPerYear: 30 }], minServiceYears: 1, capMonths: 24, proRata: true, daysInMonthDivisor: 30 },
  leaveEncashment: { enabled: true, basis: 'BASIC', daysInMonthDivisor: 30 },
  excludeUnpaidLeaveFromService: true,
  recoverNoticeShortfall: true,
};
