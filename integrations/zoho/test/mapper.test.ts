import { describe, expect, it } from 'vitest';
import { mapZohoEmployee, toIsoDate, extractEmployeeNo } from '../src/index.js';
describe('zoho mapper', () => {
  it('maps a standard export row', () => {
    const out = mapZohoEmployee({ recordId: '123', EmployeeID: 'bp-26-777', FirstName: 'Ahmed', LastName: 'Khan', EmailID: 'A.Khan@Burtplace.ae', Gender: 'Male', Dateofjoining: '15-Mar-2024', Department: 'CIVIL', Reporting_To: 'John Yusuf BP-26-019', Employee_type: 'Permanent', Employeestatus: 'Active' });
    expect(out).toMatchObject({ zohoRecordId: '123', employeeNo: 'BP-26-777', firstName: 'Ahmed', workEmail: 'a.khan@burtplace.ae', gender: 'MALE', joiningDate: '2024-03-15', departmentCode: 'CIVIL', managerEmployeeNo: 'BP-26-019', employmentType: 'FULL_TIME', status: 'ACTIVE' });
  });
  it('parses date formats and manager references', () => {
    expect(toIsoDate('05/09/2026')).toBe('2026-09-05'); expect(toIsoDate('2026-09-05')).toBe('2026-09-05'); expect(toIsoDate('garbage')).toBeUndefined();
    expect(extractEmployeeNo('BP-26-001 - Someone')).toBe('BP-26-001'); expect(extractEmployeeNo('Someone')).toBeUndefined();
  });
});
