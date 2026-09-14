import { describe, expect, it } from 'vitest';
import { eventFingerprint } from '../src/fingerprint.js';

describe('eventFingerprint', () => {
  it('is deterministic and normalises inputs', () => {
    const a = eventFingerprint({ externalUserId: '777', punchedAt: new Date('2026-09-01T02:00:00Z'), direction: 'in', deviceCode: 'ARGO-1' });
    const b = eventFingerprint({ externalUserId: ' 777 ', punchedAt: '2026-09-01T02:00:00.000Z', direction: 'IN', deviceCode: 'ARGO-1 ' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
  it('differs when any component differs', () => {
    const base = { externalUserId: '777', punchedAt: '2026-09-01T02:00:00Z', direction: 'IN', deviceCode: 'ARGO-1' };
    const fp = eventFingerprint(base);
    expect(eventFingerprint({ ...base, externalUserId: '778' })).not.toBe(fp);
    expect(eventFingerprint({ ...base, punchedAt: '2026-09-01T02:00:01Z' })).not.toBe(fp);
    expect(eventFingerprint({ ...base, direction: 'OUT' })).not.toBe(fp);
    expect(eventFingerprint({ ...base, deviceCode: 'ARGO-2' })).not.toBe(fp);
  });
});
