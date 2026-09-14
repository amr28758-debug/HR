import type { EmployeeStatus } from '@burtplace/types';

export interface TransitionRule {
  to: EmployeeStatus;
  permission: string;
  requiresApproval?: boolean;
  workflowCode?: string;
  onEnter?: ('create_onboarding_checklist' | 'create_clearance_checklist' | 'disable_access' | 'archive')[];
}

/** Employee lifecycle state machine. Edges are configuration; the API enforces permission + audit + optional workflow. */
export const LIFECYCLE: Record<EmployeeStatus, TransitionRule[]> = {
  CANDIDATE: [{ to: 'OFFER', permission: 'employees:transition' }, { to: 'ARCHIVED', permission: 'employees:transition' }],
  OFFER: [{ to: 'APPROVED', permission: 'employees:transition', requiresApproval: true }, { to: 'CANDIDATE', permission: 'employees:transition' }, { to: 'ARCHIVED', permission: 'employees:transition' }],
  APPROVED: [{ to: 'PRE_ONBOARDING', permission: 'employees:transition' }, { to: 'ARCHIVED', permission: 'employees:transition' }],
  PRE_ONBOARDING: [{ to: 'ONBOARDING', permission: 'employees:transition', onEnter: ['create_onboarding_checklist'] }],
  ONBOARDING: [{ to: 'ACTIVE', permission: 'employees:transition' }, { to: 'PROBATION', permission: 'employees:transition' }],
  ACTIVE: [
    { to: 'PROBATION', permission: 'employees:transition' }, { to: 'CONFIRMED', permission: 'employees:transition' }, { to: 'TRANSFERRED', permission: 'employees:transition' },
    { to: 'PROMOTED', permission: 'employees:transition' }, { to: 'RESIGNED', permission: 'employees:transition', workflowCode: 'RESIGNATION' }, { to: 'TERMINATED', permission: 'employees:transition', requiresApproval: true },
  ],
  PROBATION: [{ to: 'CONFIRMED', permission: 'employees:transition' }, { to: 'ACTIVE', permission: 'employees:transition' }, { to: 'RESIGNED', permission: 'employees:transition', workflowCode: 'RESIGNATION' }, { to: 'TERMINATED', permission: 'employees:transition', requiresApproval: true }],
  CONFIRMED: [{ to: 'ACTIVE', permission: 'employees:transition' }, { to: 'TRANSFERRED', permission: 'employees:transition' }, { to: 'PROMOTED', permission: 'employees:transition' }, { to: 'RESIGNED', permission: 'employees:transition', workflowCode: 'RESIGNATION' }, { to: 'TERMINATED', permission: 'employees:transition', requiresApproval: true }],
  TRANSFERRED: [{ to: 'ACTIVE', permission: 'employees:transition' }],
  PROMOTED: [{ to: 'ACTIVE', permission: 'employees:transition' }],
  RESIGNED: [{ to: 'CLEARANCE', permission: 'employees:transition', onEnter: ['create_clearance_checklist'] }, { to: 'ACTIVE', permission: 'employees:transition' }],
  TERMINATED: [{ to: 'CLEARANCE', permission: 'employees:transition', onEnter: ['create_clearance_checklist'] }],
  CLEARANCE: [{ to: 'FINAL_SETTLEMENT', permission: 'employees:transition', requiresApproval: true }],
  FINAL_SETTLEMENT: [{ to: 'ARCHIVED', permission: 'employees:transition', onEnter: ['disable_access', 'archive'] }],
  ARCHIVED: [],
};

/** Statuses considered "on payroll / expected at work". */
export const WORKING_STATUSES: EmployeeStatus[] = ['ACTIVE', 'PROBATION', 'CONFIRMED', 'TRANSFERRED', 'PROMOTED', 'RESIGNED', 'CLEARANCE'];

export function canTransition(from: EmployeeStatus, to: EmployeeStatus): TransitionRule | null {
  return LIFECYCLE[from].find((r) => r.to === to) ?? null;
}

export function nextStatuses(from: EmployeeStatus): EmployeeStatus[] {
  return LIFECYCLE[from].map((r) => r.to);
}
