/**
 * Shared domain vocabulary for Burtplace Workforce.
 * These enums mirror the PostgreSQL enum types in packages/database/migrations.
 */

export const EMPLOYEE_STATUSES = [
  'CANDIDATE',
  'OFFER',
  'APPROVED',
  'PRE_ONBOARDING',
  'ONBOARDING',
  'ACTIVE',
  'PROBATION',
  'CONFIRMED',
  'TRANSFERRED',
  'PROMOTED',
  'RESIGNED',
  'TERMINATED',
  'CLEARANCE',
  'FINAL_SETTLEMENT',
  'ARCHIVED',
] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

export const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'TEMPORARY', 'INTERN', 'DAILY_WAGE'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const GENDERS = ['MALE', 'FEMALE', 'OTHER', 'UNSPECIFIED'] as const;
export type Gender = (typeof GENDERS)[number];

export const MARITAL_STATUSES = ['SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED', 'UNSPECIFIED'] as const;

export const PROBATION_STATUSES = ['NOT_APPLICABLE', 'ON_PROBATION', 'EXTENDED', 'CONFIRMED', 'FAILED'] as const;

export const DOCUMENT_TYPES = [
  'EMIRATES_ID',
  'PASSPORT',
  'VISA',
  'LABOUR_CARD',
  'INSURANCE',
  'CONTRACT',
  'DRIVING_LICENSE',
  'CERTIFICATE',
  'OTHER',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_STATUSES = ['VALID', 'EXPIRING', 'EXPIRED', 'MISSING', 'PENDING'] as const;

export const PUNCH_DIRECTIONS = ['IN', 'OUT', 'UNKNOWN'] as const;
export type PunchDirection = (typeof PUNCH_DIRECTIONS)[number];

export const VERIFICATION_METHODS = ['FACE', 'FINGER', 'CARD', 'PIN', 'PALM', 'MANUAL', 'UNKNOWN'] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

export const EVENT_SOURCES = ['DEVICE_PUSH', 'VYOM_SYNC', 'GATEWAY', 'MANUAL', 'IMPORT', 'API', 'MOBILE_FACE'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const DAY_STATUSES = [
  'PRESENT',
  'ABSENT',
  'HALF_DAY',
  'ON_LEAVE',
  'WEEK_OFF',
  'PUBLIC_HOLIDAY',
  'MISSING_PUNCH',
  'NOT_YET_JOINED',
  'EXITED',
  'UNSCHEDULED',
] as const;
export type DayStatus = (typeof DAY_STATUSES)[number];

export const ATTENDANCE_EXCEPTION_TYPES = [
  'ABSENT',
  'LATE',
  'EARLY_LEAVE',
  'MISSING_IN',
  'MISSING_OUT',
  'DUPLICATE_PUNCH',
  'INVALID_PUNCH',
  'EXCESSIVE_OT',
  'UNAPPROVED_OT',
  'WRONG_SHIFT',
  'OUTSIDE_SITE',
  'UNMAPPED_USER',
] as const;
export type AttendanceExceptionType = (typeof ATTENDANCE_EXCEPTION_TYPES)[number];

export const EXCEPTION_STATUSES = ['OPEN', 'IN_REVIEW', 'RESOLVED', 'DISMISSED'] as const;

export const SHIFT_TYPES = ['FIXED', 'FLEXIBLE', 'SPLIT'] as const;
export type ShiftType = (typeof SHIFT_TYPES)[number];

export const LEAVE_REQUEST_STATUSES = ['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export const OVERTIME_REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;

export const TIMESHEET_STATUSES = ['DRAFT', 'GENERATED', 'SUBMITTED', 'APPROVED', 'LOCKED'] as const;

export const PAYROLL_RUN_STATUSES = [
  'DRAFT',
  'CALCULATING',
  'HR_REVIEW',
  'FINANCE_REVIEW',
  'MANAGEMENT_APPROVAL',
  'APPROVED',
  'LOCKED',
  'BANK_WPS',
  'PAID',
  'CLOSED',
] as const;
export type PayrollRunStatus = (typeof PAYROLL_RUN_STATUSES)[number];

export const SALARY_COMPONENT_KINDS = ['EARNING', 'DEDUCTION'] as const;
export const CALC_METHODS = ['FIXED', 'PERCENTAGE', 'PER_DAY', 'PER_HOUR', 'PER_MINUTE', 'FORMULA'] as const;
export type CalcMethod = (typeof CALC_METHODS)[number];

export const DEVICE_STATUSES = ['ONLINE', 'OFFLINE', 'UNKNOWN', 'ERROR', 'DECOMMISSIONED'] as const;

export const WORKFLOW_INSTANCE_STATUSES = ['PENDING', 'IN_PROGRESS', 'APPROVED', 'REJECTED', 'CANCELLED', 'COMPLETED'] as const;
export const WORKFLOW_TASK_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'SKIPPED', 'CANCELLED'] as const;

export const ROLES = [
  'SUPER_ADMIN',
  'HR_ADMIN',
  'HR_MANAGER',
  'PAYROLL_OFFICER',
  'FINANCE',
  'FINANCE_MANAGER',
  'PROJECT_MANAGER',
  'DEPARTMENT_MANAGER',
  'IT_ADMIN',
  'EMPLOYEE',
  'AUDITOR',
  'MANAGEMENT',
  'SERVICE_DEVICE_GATEWAY',
] as const;
export type Role = (typeof ROLES)[number];

/** Standard paginated API envelope. */
export interface Paginated<T> {
  data: T[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

/** Standard API error format. */
export interface ApiError {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}
