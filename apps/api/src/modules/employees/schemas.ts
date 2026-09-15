import { z } from 'zod';
import { DOCUMENT_TYPES, EMPLOYEE_STATUSES, EMPLOYMENT_TYPES, GENDERS, MARITAL_STATUSES } from '@burtplace/types';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const nullableDate = isoDate.nullable().optional();
const nullableStr = z.string().max(500).nullable().optional();

export const employeeListQuery = z.object({
  q: z.string().optional(),
  status: z.enum(EMPLOYEE_STATUSES).optional(),
  departmentId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  managerId: z.string().uuid().optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  working: z.coerce.boolean().optional().describe('Only statuses that count as on-payroll'),
  gradeId: z.string().uuid().optional(), careerLevelId: z.string().uuid().optional(), jobFamilyId: z.string().uuid().optional(), nationality: z.string().length(2).optional(),
  costCenterId: z.string().uuid().optional(), probation: z.enum(['due', 'overdue', 'on']).optional(), contract: z.enum(['expiring']).optional(), missing: z.enum(['iban', 'biometric', 'salary']).optional(),
});

export const employeeSummary = z.object({
  id: z.string(), employeeNo: z.string(), fullNameEn: z.string(), fullNameAr: z.string().nullable(), status: z.string(), employmentType: z.string(),
  joiningDate: z.string().nullable(), probationStatus: z.string(), photoObjectKey: z.string().nullable(), mobile: z.string().nullable(), workEmail: z.string().nullable(),
  matrixUserId: z.string().nullable(), isOfficeStaff: z.boolean(),
  department: z.object({ id: z.string(), name: z.string() }).nullable(), designation: z.object({ id: z.string(), title: z.string() }).nullable(),
  site: z.object({ id: z.string(), name: z.string() }).nullable(), project: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  manager: z.object({ id: z.string(), name: z.string(), employeeNo: z.string() }).nullable(),
});

export const employeeCreate = z.object({
  employeeNo: z.string().regex(/^BP-\d{2}-\d{3,6}$/, 'Format BP-YY-NNN').optional().describe('Auto-generated when omitted'),
  matrixUserId: z.string().max(50).nullable().optional(),
  firstName: z.string().min(1).max(100), middleName: nullableStr, lastName: z.string().min(1).max(100), fullNameAr: nullableStr,
  gender: z.enum(GENDERS).default('UNSPECIFIED'), dateOfBirth: nullableDate, nationality: z.string().length(2).nullable().optional(), maritalStatus: z.enum(MARITAL_STATUSES).default('UNSPECIFIED'),
  mobile: nullableStr, workEmail: z.string().email().nullable().optional(), personalEmail: z.string().email().nullable().optional(),
  emergencyContactName: nullableStr, emergencyContactPhone: nullableStr, emergencyContactRelation: nullableStr,
  status: z.enum(EMPLOYEE_STATUSES).default('CANDIDATE'), employmentType: z.enum(EMPLOYMENT_TYPES).default('FULL_TIME'), joiningDate: nullableDate,
  probationEndDate: nullableDate, contractStartDate: nullableDate, contractEndDate: nullableDate,
  departmentId: z.string().uuid().nullable().optional(), designationId: z.string().uuid().nullable().optional(), siteId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(), costCenterId: z.string().uuid().nullable().optional(), managerEmployeeId: z.string().uuid().nullable().optional(),
  grade: nullableStr, isOfficeStaff: z.boolean().default(false),
});
export const employeeUpdate = employeeCreate.omit({ employeeNo: true, status: true }).partial().extend({ reason: z.string().max(500).optional() });

export const bankingSchema = z.object({ bankName: nullableStr, bankAccountName: nullableStr, bankAccountNumber: nullableStr, bankIban: nullableStr, bankSwift: nullableStr, wpsPersonId: nullableStr });

export const employeeDetail = employeeSummary.extend({
  firstName: z.string(), middleName: z.string().nullable(), lastName: z.string(), gender: z.string(), dateOfBirth: z.string().nullable(), nationality: z.string().nullable(), maritalStatus: z.string(),
  personalEmail: z.string().nullable(), emergencyContactName: z.string().nullable(), emergencyContactPhone: z.string().nullable(), emergencyContactRelation: z.string().nullable(),
  probationEndDate: z.string().nullable(), confirmationDate: z.string().nullable(), contractStartDate: z.string().nullable(), contractEndDate: z.string().nullable(), lastWorkingDate: z.string().nullable(),
  costCenter: z.object({ id: z.string(), code: z.string() }).nullable(), grade: z.string().nullable(), userId: z.string().nullable(), zohoRecordId: z.string().nullable(),
  banking: bankingSchema.nullable().describe('null when the caller lacks employees:banking:read'),
  allowedTransitions: z.array(z.string()), createdAt: z.string(), updatedAt: z.string(),
});

export const transitionBody = z.object({ to: z.enum(EMPLOYEE_STATUSES), effectiveDate: isoDate.optional(), reason: z.string().max(1000).optional(), lastWorkingDate: isoDate.optional() });

export const documentCreate = z.object({
  documentType: z.enum(DOCUMENT_TYPES), documentNumber: nullableStr, issueDate: nullableDate, expiryDate: nullableDate, issuingAuthority: nullableStr,
  objectKey: nullableStr, fileName: nullableStr, mimeType: nullableStr, fileSizeBytes: z.number().int().nonnegative().nullable().optional(), reminderDaysBefore: z.number().int().min(0).max(365).default(30), notes: nullableStr,
});
export const documentOut = z.object({
  id: z.string(), employeeId: z.string(), documentType: z.string(), documentNumber: z.string().nullable(), issueDate: z.string().nullable(), expiryDate: z.string().nullable(), issuingAuthority: z.string().nullable(),
  objectKey: z.string().nullable(), fileName: z.string().nullable(), status: z.string(), reminderDaysBefore: z.number(), daysToExpiry: z.number().nullable(), notes: z.string().nullable(), createdAt: z.string(),
});

export const salaryCreate = z.object({
  effectiveFrom: isoDate, currency: z.string().length(3).default('AED'), reason: z.string().max(500).optional(),
  lines: z.array(z.object({ componentCode: z.string(), amount: z.number().nonnegative() })).min(1),
});
export const salaryOut = z.object({
  id: z.string(), version: z.number(), effectiveFrom: z.string(), effectiveTo: z.string().nullable(), currency: z.string(), basicSalary: z.number(), grossSalary: z.number(), reason: z.string().nullable(), createdAt: z.string(),
  lines: z.array(z.object({ componentCode: z.string(), componentName: z.string(), kind: z.string(), amount: z.number() })),
});

export const historyOut = z.object({
  status: z.array(z.object({ fromStatus: z.string().nullable(), toStatus: z.string(), effectiveDate: z.string(), reason: z.string().nullable(), changedBy: z.string().nullable(), createdAt: z.string() })),
  employment: z.array(z.object({ effectiveFrom: z.string(), effectiveTo: z.string().nullable(), changeType: z.string(), department: z.string().nullable(), designation: z.string().nullable(), site: z.string().nullable(), project: z.string().nullable(), reason: z.string().nullable(), createdAt: z.string() })),
});
