import { describe, expect, it } from 'vitest';
import { LIFECYCLE, canTransition, nextStatuses } from '../src/lifecycle.js';
import { EMPLOYEE_STATUSES } from '@burtplace/types';

describe('lifecycle', () => {
  it('covers every status', () => {
    for (const s of EMPLOYEE_STATUSES) expect(LIFECYCLE[s]).toBeDefined();
  });
  it('allows the happy path', () => {
    const path = ['CANDIDATE', 'OFFER', 'APPROVED', 'PRE_ONBOARDING', 'ONBOARDING', 'PROBATION', 'CONFIRMED', 'RESIGNED', 'CLEARANCE', 'FINAL_SETTLEMENT', 'ARCHIVED'] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i]!, path[i + 1]!)).not.toBeNull();
  });
  it('rejects illegal jumps', () => {
    expect(canTransition('CANDIDATE', 'ACTIVE')).toBeNull();
    expect(canTransition('ARCHIVED', 'ACTIVE')).toBeNull();
    expect(nextStatuses('ARCHIVED')).toEqual([]);
  });
  it('resignation triggers the RESIGNATION workflow', () => {
    expect(canTransition('CONFIRMED', 'RESIGNED')?.workflowCode).toBe('RESIGNATION');
  });
});
