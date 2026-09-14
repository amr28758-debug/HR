/**
 * Zoho People → Burtplace mapper (LEGACY / REMOVABLE).
 *
 * Scope: transform a Zoho People *export* (CSV/JSON rows) into the normalised employee rows accepted by
 * POST /api/v1/migration/batches. It never calls Zoho APIs and core never imports it: delete this folder and the
 * platform is unaffected.
 *
 * REQUIRES CONFIRMATION: exact export column names differ per Zoho People configuration. The default map below covers the
 * standard "Employee Details" export; override `columnMap` for customised forms.
 */
export interface ZohoColumnMap { [burtplaceField: string]: string | string[] }

export const DEFAULT_ZOHO_COLUMN_MAP: ZohoColumnMap = {
  zohoRecordId: ['recordId', 'Zoho ID', 'EmployeeID_ZohoId'],
  employeeNo: ['EmployeeID', 'Employee ID'],
  firstName: ['FirstName', 'First Name'],
  lastName: ['LastName', 'Last Name'],
  workEmail: ['EmailID', 'Email address'],
  mobile: ['Mobile', 'Mobile Number'],
  gender: ['Gender'],
  dateOfBirth: ['Date_of_birth', 'Date of birth'],
  nationality: ['Nationality'],
  joiningDate: ['Dateofjoining', 'Date of joining'],
  departmentCode: ['Department'],
  designationCode: ['Designation'],
  siteCode: ['Location', 'Work location'],
  managerEmployeeNo: ['Reporting_To', 'Reporting To'],
  employmentType: ['Employee_type', 'Employee type'],
  status: ['Employeestatus', 'Employee Status'],
};

const GENDER: Record<string, string> = { male: 'MALE', female: 'FEMALE' };
const EMPLOYMENT: Record<string, string> = { permanent: 'FULL_TIME', 'full time': 'FULL_TIME', contract: 'CONTRACT', temporary: 'TEMPORARY', intern: 'INTERN', 'part time': 'PART_TIME' };
const STATUS: Record<string, string> = { active: 'ACTIVE', probation: 'PROBATION', confirmed: 'CONFIRMED', resigned: 'RESIGNED', terminated: 'TERMINATED', inactive: 'ARCHIVED' };

function pick(row: Record<string, unknown>, keys: string | string[]): string | undefined {
  for (const k of Array.isArray(keys) ? keys : [keys]) { const v = row[k]; if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim(); }
  return undefined;
}
/** Zoho exports dates as DD-MMM-YYYY or DD/MM/YYYY depending on org settings → ISO. Unparseable → undefined (row flagged by validation if required). */
export function toIsoDate(v: string | undefined): string | undefined {
  if (!v) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m1 = v.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m1) return `${m1[3]}-${m1[2]!.padStart(2, '0')}-${m1[1]!.padStart(2, '0')}`;
  const m2 = v.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (m2) { const mon = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m2[2]!.toLowerCase()) + 1; if (mon) return `${m2[3]}-${String(mon).padStart(2, '0')}-${m2[1]!.padStart(2, '0')}`; }
  return undefined;
}
/** A Zoho "Reporting_To" value usually looks like "Name BP-26-019" or "BP-26-019 - Name"; extract the employee number when present. */
export function extractEmployeeNo(v: string | undefined): string | undefined {
  return v?.match(/BP-\d{2}-\d{3,6}/i)?.[0]?.toUpperCase();
}

export function mapZohoEmployee(row: Record<string, unknown>, columnMap: ZohoColumnMap = DEFAULT_ZOHO_COLUMN_MAP): Record<string, unknown> {
  const g = (f: string) => pick(row, columnMap[f] ?? f);
  const out: Record<string, unknown> = {
    sourceId: g('zohoRecordId'), zohoRecordId: g('zohoRecordId'), employeeNo: g('employeeNo')?.toUpperCase(), firstName: g('firstName'), lastName: g('lastName'), workEmail: g('workEmail')?.toLowerCase(), mobile: g('mobile'),
    gender: GENDER[(g('gender') ?? '').toLowerCase()] ?? 'UNSPECIFIED', dateOfBirth: toIsoDate(g('dateOfBirth')), nationality: g('nationality')?.slice(0, 2).toUpperCase(), joiningDate: toIsoDate(g('joiningDate')),
    departmentCode: g('departmentCode'), designationCode: g('designationCode'), siteCode: g('siteCode'), managerEmployeeNo: extractEmployeeNo(g('managerEmployeeNo')),
    employmentType: EMPLOYMENT[(g('employmentType') ?? '').toLowerCase()] ?? 'FULL_TIME', status: STATUS[(g('status') ?? '').toLowerCase()] ?? 'ACTIVE',
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}
export function mapZohoEmployees(rows: Record<string, unknown>[], columnMap?: ZohoColumnMap): Record<string, unknown>[] {
  return rows.map((r) => mapZohoEmployee(r, columnMap));
}
