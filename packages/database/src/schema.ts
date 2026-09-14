/**
 * Kysely table typings. Keep in sync with packages/database/migrations.
 * Convention: Generated<T> for DB-defaulted columns; numeric columns come back as string.
 */
import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';
import type {
  EmployeeStatus, EmploymentType, Gender, DocumentType, PunchDirection, VerificationMethod, EventSource,
  DayStatus, AttendanceExceptionType, ShiftType, PayrollRunStatus, CalcMethod,
} from '@burtplace/types';

type Timestamp = ColumnType<string, string | Date, string | Date>;
type DateCol = ColumnType<string, string, string>;
type Numeric = ColumnType<string, number | string, number | string>;
type Json<T = unknown> = ColumnType<T, string | T, string | T>;

export interface RolesTable {
  id: Generated<string>; code: string; name: string; description: string | null; is_system: Generated<boolean>;
  created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
export interface PermissionsTable { id: Generated<string>; code: string; description: string | null }
export interface RolePermissionsTable { role_id: string; permission_id: string }
export interface UsersTable {
  id: Generated<string>; email: string | null; display_name: string; entra_object_id: string | null; entra_upn: string | null;
  local_password_hash: string | null; is_service_account: Generated<boolean>; is_active: Generated<boolean>; locale: Generated<string>;
  last_login_at: Timestamp | null; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>; deleted_at: Timestamp | null;
}
export interface UserRolesTable { user_id: string; role_id: string; granted_by: string | null; granted_at: Generated<Timestamp> }
export interface ApiKeysTable {
  id: Generated<string>; user_id: string; name: string; key_prefix: string; key_hash: string; scopes: Generated<string[]>;
  expires_at: Timestamp | null; last_used_at: Timestamp | null; revoked_at: Timestamp | null; created_by: string | null; created_at: Generated<Timestamp>;
}
export interface AuditLogsTable {
  id: Generated<number>; occurred_at: Generated<Timestamp>; actor_user_id: string | null; actor_label: string | null; action: string;
  entity_type: string; entity_id: string | null; old_value: Json | null; new_value: Json | null; reason: string | null;
  ip_address: string | null; user_agent: string | null; source: Generated<string>; approval_ref: string | null; request_id: string | null; metadata: Json | null;
}

export interface CostCentersTable {
  id: Generated<string>; code: string; name: string; name_ar: string | null; is_active: Generated<boolean>;
  created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>; deleted_at: Timestamp | null;
}
export interface DepartmentsTable {
  id: Generated<string>; code: string; name: string; name_ar: string | null; parent_id: string | null; manager_employee_id: string | null;
  cost_center_id: string | null; is_active: Generated<boolean>; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>; deleted_at: Timestamp | null;
}
export interface DesignationsTable {
  id: Generated<string>; code: string; title: string; title_ar: string | null; grade: string | null; is_active: Generated<boolean>;
  created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>; deleted_at: Timestamp | null;
}
export interface ProjectsTable {
  id: Generated<string>; code: string; name: string; name_ar: string | null; client_name: string | null; status: Generated<string>;
  start_date: DateCol | null; end_date: DateCol | null; cost_center_id: string | null; manager_employee_id: string | null;
  created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>; deleted_at: Timestamp | null;
}
export interface SitesTable {
  id: Generated<string>; code: string; name: string; name_ar: string | null; site_type: Generated<string>; project_id: string | null;
  address: string | null; emirate: string | null; latitude: Numeric | null; longitude: Numeric | null; geofence_radius_m: number | null;
  timezone: Generated<string>; is_active: Generated<boolean>; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>; deleted_at: Timestamp | null;
}
export interface HolidaysTable {
  id: Generated<string>; name: string; name_ar: string | null; holiday_date: DateCol; end_date: DateCol | null; is_paid: Generated<boolean>;
  applies_to_site_id: string | null; year: Generated<number>; created_at: Generated<Timestamp>;
}

export interface EmployeesTable {
  id: Generated<string>; employee_no: string; matrix_user_id: string | null; zoho_record_id: string | null; user_id: string | null;
  first_name: string; middle_name: string | null; last_name: string; full_name_en: Generated<string>; full_name_ar: string | null;
  photo_object_key: string | null; gender: Generated<Gender>; date_of_birth: DateCol | null; nationality: string | null;
  marital_status: Generated<string>; mobile: string | null; work_email: string | null; personal_email: string | null;
  emergency_contact_name: string | null; emergency_contact_phone: string | null; emergency_contact_relation: string | null;
  status: Generated<EmployeeStatus>; employment_type: Generated<EmploymentType>; joining_date: DateCol | null;
  probation_status: Generated<string>; probation_end_date: DateCol | null; confirmation_date: DateCol | null;
  contract_start_date: DateCol | null; contract_end_date: DateCol | null; last_working_date: DateCol | null;
  department_id: string | null; designation_id: string | null; site_id: string | null; project_id: string | null; cost_center_id: string | null;
  manager_employee_id: string | null; grade: string | null; is_office_staff: Generated<boolean>;
  bank_name: string | null; bank_account_name: string | null; bank_account_number: string | null; bank_iban: string | null; bank_swift: string | null; wps_person_id: string | null;
  search_vector: Generated<string | null>; created_by: string | null; updated_by: string | null;
  created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>; deleted_at: Timestamp | null;
}
export interface EmployeeStatusHistoryTable {
  id: Generated<number>; employee_id: string; from_status: EmployeeStatus | null; to_status: EmployeeStatus; effective_date: Generated<DateCol>;
  reason: string | null; changed_by: string | null; workflow_instance_id: string | null; created_at: Generated<Timestamp>;
}
export interface EmploymentHistoryTable {
  id: Generated<number>; employee_id: string; effective_from: DateCol; effective_to: DateCol | null; change_type: string;
  department_id: string | null; designation_id: string | null; site_id: string | null; project_id: string | null; cost_center_id: string | null;
  manager_employee_id: string | null; grade: string | null; employment_type: EmploymentType | null; reason: string | null; changed_by: string | null; created_at: Generated<Timestamp>;
}
export interface EmployeeContractsTable {
  id: Generated<string>; employee_id: string; contract_no: string | null; contract_type: Generated<string>; start_date: DateCol; end_date: DateCol | null;
  probation_months: number | null; notice_period_days: number | null; weekly_hours: Numeric | null; document_object_key: string | null;
  is_current: Generated<boolean>; created_by: string | null; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
export interface EmployeeDocumentsTable {
  id: Generated<string>; employee_id: string; document_type: DocumentType; document_number: string | null; issue_date: DateCol | null; expiry_date: DateCol | null;
  issuing_authority: string | null; object_key: string | null; file_name: string | null; mime_type: string | null; file_size_bytes: number | null;
  status: Generated<string>; reminder_days_before: Generated<number>; last_reminded_at: Timestamp | null; notes: string | null; created_by: string | null;
  created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>; deleted_at: Timestamp | null;
}

export interface SalaryComponentsTable {
  id: Generated<string>; code: string; name: string; name_ar: string | null; kind: 'EARNING' | 'DEDUCTION'; calc_method: Generated<CalcMethod>; formula: string | null;
  is_fixed_pay: Generated<boolean>; is_taxable: Generated<boolean>; is_wps_reportable: Generated<boolean>; sort_order: Generated<number>; is_active: Generated<boolean>;
  created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
export interface EmployeeSalaryStructuresTable {
  id: Generated<string>; employee_id: string; version: number; effective_from: DateCol; effective_to: DateCol | null; currency: Generated<string>;
  basic_salary: Numeric; gross_salary: Numeric; reason: string | null; approved_by: string | null; workflow_instance_id: string | null; created_by: string | null; created_at: Generated<Timestamp>;
}
export interface EmployeeSalaryLinesTable { id: Generated<string>; salary_structure_id: string; component_id: string; amount: Generated<Numeric>; percentage: Numeric | null }
export interface PayrollPoliciesTable {
  id: Generated<string>; code: string; version: number; name: string; effective_from: DateCol; effective_to: DateCol | null; is_statutory: Generated<boolean>;
  config: Json; notes: string | null; created_by: string | null; created_at: Generated<Timestamp>;
}

export interface DevicesTable {
  id: Generated<string>; device_code: string; name: string; vendor: Generated<string>; model: string | null; firmware_version: string | null; ip_address: string | null;
  mac_address: string | null; site_id: string | null; status: Generated<string>; last_seen_at: Timestamp | null; last_sync_at: Timestamp | null; last_punch_at: Timestamp | null;
  last_error: string | null; last_error_at: Timestamp | null; enrolled_user_count: number | null; timezone: Generated<string>; config: Generated<Json>; is_active: Generated<boolean>;
  created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>; deleted_at: Timestamp | null;
}
export interface DeviceSitesTable { id: Generated<number>; device_id: string; site_id: string; from_date: Generated<DateCol>; to_date: DateCol | null }
export interface BiometricMappingsTable {
  id: Generated<string>; employee_id: string; provider: Generated<string>; external_user_id: string; enrolled_devices: Generated<string[]>; enrolled_at: Timestamp | null;
  is_active: Generated<boolean>; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
export interface AttendanceRawEventsTable {
  id: Generated<string>; event_fingerprint: string; external_user_id: string; employee_id: string | null; device_id: string | null; device_code: string; site_id: string | null;
  punched_at: Timestamp; direction: Generated<PunchDirection>; verification_method: Generated<VerificationMethod>; source: EventSource; vendor_event_id: string | null;
  vendor_payload: Json | null; received_at: Generated<Timestamp>; ingest_batch_id: string | null; processed_at: Timestamp | null; processing_error: string | null;
}
export interface AttendanceCorrectionsTable {
  id: Generated<string>; employee_id: string; attendance_date: DateCol; raw_event_id: string | null; correction_type: string; punched_at: Timestamp | null; direction: PunchDirection | null;
  override_status: DayStatus | null; override_worked_minutes: number | null; reason: string; requested_by: string; approved_by: string | null; approved_at: Timestamp | null;
  workflow_instance_id: string | null; status: Generated<string>; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
export interface AttendanceEventsTable {
  id: Generated<string>; employee_id: string; raw_event_id: string | null; correction_id: string | null; attendance_date: DateCol; punched_at: Timestamp; direction: PunchDirection;
  device_id: string | null; site_id: string | null; is_ignored: Generated<boolean>; ignore_reason: string | null; created_at: Generated<Timestamp>;
}
export interface AttendanceDailyTable {
  id: Generated<string>; employee_id: string; attendance_date: DateCol; shift_id: string | null; site_id: string | null; project_id: string | null; status: DayStatus;
  first_in_at: Timestamp | null; last_out_at: Timestamp | null; scheduled_start_at: Timestamp | null; scheduled_end_at: Timestamp | null;
  scheduled_minutes: Generated<number>; worked_minutes: Generated<number>; break_minutes: Generated<number>; net_worked_minutes: Generated<number>;
  late_minutes: Generated<number>; early_leave_minutes: Generated<number>; overtime_minutes: Generated<number>; approved_overtime_minutes: Generated<number>;
  holiday_minutes: Generated<number>; weekend_minutes: Generated<number>; leave_request_id: string | null; leave_type_code: string | null; is_paid_day: Generated<boolean>;
  punch_count: Generated<number>; is_manual_override: Generated<boolean>; override_correction_id: string | null; calculation_version: Generated<number>;
  calculated_at: Generated<Timestamp>; locked_at: Timestamp | null;
}
export interface AttendanceExceptionsTable {
  id: Generated<string>; employee_id: string | null; attendance_date: DateCol; exception_type: AttendanceExceptionType; status: Generated<string>; severity: Generated<string>;
  details: Generated<Json>; raw_event_id: string | null; resolved_by: string | null; resolved_at: Timestamp | null; resolution_note: string | null;
  created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
export interface AttendanceIngestBatchesTable {
  id: Generated<string>; source: EventSource; device_id: string | null; received_count: Generated<number>; inserted_count: Generated<number>; duplicate_count: Generated<number>;
  rejected_count: Generated<number>; actor_user_id: string | null; created_at: Generated<Timestamp>;
}

export interface ShiftsTable {
  id: Generated<string>; code: string; name: string; name_ar: string | null; shift_type: Generated<ShiftType>; start_time: string; end_time: string; crosses_midnight: Generated<boolean>;
  required_minutes: number; break_minutes: Generated<number>; break_is_paid: Generated<boolean>; break_start_time: string | null; break_end_time: string | null;
  grace_in_minutes: Generated<number>; grace_out_minutes: Generated<number>; early_in_window_minutes: Generated<number>; late_out_window_minutes: Generated<number>;
  half_day_threshold_minutes: number | null; absent_threshold_minutes: Generated<number>; ot_enabled: Generated<boolean>; ot_after_minutes: number | null;
  ot_min_block_minutes: Generated<number>; ot_max_minutes_per_day: number | null; ot_rounding_minutes: Generated<number>; ot_requires_approval: Generated<boolean>;
  count_early_in_as_ot: Generated<boolean>; timezone: Generated<string>; is_active: Generated<boolean>; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>; deleted_at: Timestamp | null;
}
export interface ShiftRulesTable {
  id: Generated<string>; scope: string; scope_id: string | null; rule_type: string; config: Json; priority: Generated<number>; effective_from: Generated<DateCol>; effective_to: DateCol | null;
  is_active: Generated<boolean>; created_at: Generated<Timestamp>;
}
export interface WorkPatternsTable {
  id: Generated<string>; code: string; name: string; week_offs: Generated<number[]>; default_shift_id: string | null; weekday_shifts: Generated<Json<Record<string, string>>>;
  is_active: Generated<boolean>; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
export interface ShiftAssignmentsTable {
  id: Generated<string>; employee_id: string | null; site_id: string | null; project_id: string | null; work_pattern_id: string | null; shift_id: string | null;
  effective_from: DateCol; effective_to: DateCol | null; priority: Generated<number>; created_by: string | null; created_at: Generated<Timestamp>;
}

export interface LeaveTypesTable {
  id: Generated<string>; code: string; name: string; name_ar: string | null; is_paid: Generated<boolean>; pay_percentage: Generated<Numeric>; affects_attendance: Generated<boolean>;
  requires_attachment: Generated<boolean>; color: string | null; sort_order: Generated<number>; is_active: Generated<boolean>; created_at: Generated<Timestamp>;
}
export interface LeavePoliciesTable {
  id: Generated<string>; leave_type_id: string; code: string; name: string; applies_to: Generated<Json>; annual_entitlement_days: Generated<Numeric>; accrual_method: Generated<string>;
  accrual_starts_after_days: Generated<number>; max_carry_forward_days: Generated<Numeric>; carry_forward_expiry_months: number | null; max_balance_days: Numeric | null;
  allow_negative_days: Generated<Numeric>; encashable: Generated<boolean>; min_notice_days: Generated<number>; count_week_offs: Generated<boolean>; count_holidays: Generated<boolean>;
  is_statutory: Generated<boolean>; effective_from: Generated<DateCol>; effective_to: DateCol | null; is_active: Generated<boolean>; created_at: Generated<Timestamp>;
}
export interface LeaveBalancesTable {
  id: Generated<string>; employee_id: string; leave_type_id: string; period_year: number; opening_days: Generated<Numeric>; accrued_days: Generated<Numeric>; used_days: Generated<Numeric>;
  pending_days: Generated<Numeric>; adjusted_days: Generated<Numeric>; encashed_days: Generated<Numeric>; balance_days: Generated<Numeric>; last_accrued_at: DateCol | null; updated_at: Generated<Timestamp>;
}
export interface LeaveBalanceTransactionsTable {
  id: Generated<number>; balance_id: string; txn_type: string; days: Numeric; reference_id: string | null; note: string | null; created_by: string | null; created_at: Generated<Timestamp>;
}
export interface LeaveRequestsTable {
  id: Generated<string>; employee_id: string; leave_type_id: string; start_date: DateCol; end_date: DateCol; is_half_day: Generated<boolean>; half_day_part: string | null; total_days: Numeric;
  reason: string | null; attachment_object_key: string | null; status: Generated<string>; workflow_instance_id: string | null; requested_by: string | null; decided_by: string | null;
  decided_at: Timestamp | null; decision_note: string | null; cancelled_at: Timestamp | null; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
export interface OvertimeRulesTable {
  id: Generated<string>; code: string; name: string; day_kind: string; multiplier: Generated<Numeric>; scope: Generated<string>; scope_id: string | null; min_minutes: Generated<number>;
  max_minutes_per_day: number | null; max_minutes_per_month: number | null; rounding_minutes: Generated<number>; requires_manager_approval: Generated<boolean>;
  requires_hr_approval_over_minutes: number | null; is_statutory: Generated<boolean>; effective_from: Generated<DateCol>; effective_to: DateCol | null; priority: Generated<number>;
  is_active: Generated<boolean>; created_at: Generated<Timestamp>;
}
export interface OvertimeRequestsTable {
  id: Generated<string>; employee_id: string; attendance_date: DateCol; attendance_daily_id: string | null; requested_minutes: number; approved_minutes: number | null; day_kind: Generated<string>;
  overtime_rule_id: string | null; multiplier: Numeric | null; reason: string | null; status: Generated<string>; workflow_instance_id: string | null; requested_by: string | null;
  decided_by: string | null; decided_at: Timestamp | null; decision_note: string | null; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}

export interface TimesheetsTable {
  id: Generated<string>; employee_id: string; period_year: number; period_month: number; period_start: DateCol; period_end: DateCol; status: Generated<string>;
  site_id: string | null; project_id: string | null; department_id: string | null; cost_center_id: string | null; calendar_days: number; scheduled_days: Generated<number>;
  present_days: Generated<Numeric>; absent_days: Generated<Numeric>; paid_leave_days: Generated<Numeric>; unpaid_leave_days: Generated<Numeric>; week_off_days: Generated<number>;
  holiday_days: Generated<number>; missing_punch_days: Generated<number>; scheduled_minutes: Generated<number>; worked_minutes: Generated<number>; normal_minutes: Generated<number>;
  overtime_minutes: Generated<number>; unapproved_overtime_minutes: Generated<number>; weekend_ot_minutes: Generated<number>; holiday_ot_minutes: Generated<number>;
  late_minutes: Generated<number>; early_leave_minutes: Generated<number>; late_count: Generated<number>; adjustments: Generated<Json>; generated_at: Generated<Timestamp>;
  submitted_by: string | null; submitted_at: Timestamp | null; approved_by: string | null; approved_at: Timestamp | null; locked_at: Timestamp | null; payroll_run_id: string | null;
}
export interface TimesheetLinesTable {
  id: Generated<string>; timesheet_id: string; attendance_date: DateCol; attendance_daily_id: string | null; status: DayStatus; scheduled_minutes: Generated<number>; worked_minutes: Generated<number>;
  normal_minutes: Generated<number>; overtime_minutes: Generated<number>; late_minutes: Generated<number>; early_leave_minutes: Generated<number>; day_kind: Generated<string>;
  leave_type_code: string | null; is_paid: Generated<boolean>;
}
export interface PayrollRunsTable {
  id: Generated<string>; code: string; period_year: number; period_month: number; period_start: DateCol; period_end: DateCol; payment_date: DateCol | null; status: Generated<PayrollRunStatus>;
  policy_id: string | null; currency: Generated<string>; employee_count: Generated<number>; total_gross: Generated<Numeric>; total_earnings: Generated<Numeric>; total_deductions: Generated<Numeric>;
  total_net: Generated<Numeric>; filters: Generated<Json>; notes: string | null; created_by: string | null; hr_reviewed_by: string | null; hr_reviewed_at: Timestamp | null;
  finance_reviewed_by: string | null; finance_reviewed_at: Timestamp | null; approved_by: string | null; approved_at: Timestamp | null; locked_by: string | null; locked_at: Timestamp | null;
  paid_at: Timestamp | null; closed_at: Timestamp | null; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
export interface PayrollEmployeesTable {
  id: Generated<string>; payroll_run_id: string; employee_id: string; timesheet_id: string | null; salary_structure_id: string | null; employee_no: string; employee_name: string;
  department_id: string | null; site_id: string | null; project_id: string | null; cost_center_id: string | null; basic_salary: Numeric; gross_salary: Numeric; daily_rate: Numeric; hourly_rate: Numeric;
  worked_days: Generated<Numeric>; paid_days: Generated<Numeric>; unpaid_leave_days: Generated<Numeric>; absent_days: Generated<Numeric>; overtime_minutes: Generated<number>;
  total_earnings: Generated<Numeric>; total_deductions: Generated<Numeric>; net_salary: Generated<Numeric>; bank_iban: string | null; calculation_trace: Json | null;
  has_exceptions: Generated<boolean>; exceptions: Generated<Json>; calculated_at: Generated<Timestamp>;
}
export interface PayrollLinesTable {
  id: Generated<string>; payroll_employee_id: string; component_id: string; component_code: string; description: string | null; quantity: Numeric | null; rate: Numeric | null; amount: Numeric;
  is_adjustment: Generated<boolean>; adjustment_id: string | null;
}
export interface PayrollAdjustmentsTable {
  id: Generated<string>; employee_id: string; component_id: string; origin_run_id: string | null; target_run_id: string | null; amount: Numeric; reason: string; status: Generated<string>;
  workflow_instance_id: string | null; requested_by: string | null; approved_by: string | null; approved_at: Timestamp | null; applied_at: Timestamp | null; created_at: Generated<Timestamp>;
}
export interface PayslipsTable {
  id: Generated<string>; payroll_employee_id: string; payslip_no: string; object_key: string | null; locale: Generated<string>; generated_at: Generated<Timestamp>; published_at: Timestamp | null; viewed_at: Timestamp | null;
}
export interface EmployeeLoansTable {
  id: Generated<string>; employee_id: string; loan_type: Generated<string>; principal: Numeric; installment: Numeric; outstanding: Numeric; start_period: DateCol; status: Generated<string>;
  notes: string | null; created_by: string | null; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}

export interface WorkflowDefinitionsTable {
  id: Generated<string>; code: string; version: Generated<number>; name: string; entity_type: string; trigger: Json; conditions: Generated<Json>; steps: Json; actions: Generated<Json>;
  is_active: Generated<boolean>; created_by: string | null; created_at: Generated<Timestamp>;
}
export interface WorkflowInstancesTable {
  id: Generated<string>; definition_id: string; entity_type: string; entity_id: string; status: Generated<string>; current_step: Generated<number>; context: Generated<Json>;
  initiated_by: string | null; completed_at: Timestamp | null; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
export interface WorkflowTasksTable {
  id: Generated<string>; instance_id: string; step_index: number; step_key: string; assignee_user_id: string | null; assignee_role_code: string | null; status: Generated<string>;
  decided_by: string | null; decided_at: Timestamp | null; comment: string | null; due_at: Timestamp | null; created_at: Generated<Timestamp>;
}
export interface NotificationsTable {
  id: Generated<string>; user_id: string; channel: Generated<string>; type: string; title: string; body: string | null; link: string | null; payload: Json | null;
  read_at: Timestamp | null; sent_at: Timestamp | null; send_error: string | null; created_at: Generated<Timestamp>;
}
export interface AssetsTable {
  id: Generated<string>; asset_tag: string; category: string; name: string; serial_number: string | null; status: Generated<string>; site_id: string | null; purchase_date: DateCol | null;
  notes: string | null; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>; deleted_at: Timestamp | null;
}
export interface EmployeeAssetsTable {
  id: Generated<string>; asset_id: string; employee_id: string; assigned_at: Generated<DateCol>; returned_at: DateCol | null; condition_out: string | null; condition_in: string | null;
  assigned_by: string | null; created_at: Generated<Timestamp>;
}
export interface ChecklistTemplatesTable { id: Generated<string>; code: string; name: string; items: Json; is_active: Generated<boolean>; created_at: Generated<Timestamp> }
export interface ChecklistInstancesTable { id: Generated<string>; template_id: string; employee_id: string; status: Generated<string>; created_at: Generated<Timestamp>; completed_at: Timestamp | null }
export interface ChecklistTasksTable {
  id: Generated<string>; instance_id: string; item_key: string; title: string; group_name: string; owner_role_code: string | null; owner_user_id: string | null; is_required: Generated<boolean>;
  status: Generated<string>; completed_by: string | null; completed_at: Timestamp | null; note: string | null; due_at: Timestamp | null; created_at: Generated<Timestamp>;
}
export interface IntegrationConnectionsTable {
  id: Generated<string>; code: string; provider: string; status: Generated<string>; config: Generated<Json>; last_success_at: Timestamp | null; last_error_at: Timestamp | null;
  last_error: string | null; cursor: Json | null; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
export interface IntegrationLogsTable {
  id: Generated<number>; connection_id: string | null; operation: string; direction: Generated<string>; status: string; request_summary: Json | null; response_summary: Json | null;
  duration_ms: number | null; created_at: Generated<Timestamp>;
}
export interface IntegrationFailuresTable {
  id: Generated<string>; connection_id: string | null; operation: string; payload: Json | null; error: string; attempts: Generated<number>; next_retry_at: Timestamp | null;
  resolved_at: Timestamp | null; created_at: Generated<Timestamp>;
}
export interface MigrationBatchesTable {
  id: Generated<string>; source: string; entity_type: string; file_name: string | null; status: Generated<string>; total_rows: Generated<number>; valid_rows: Generated<number>;
  applied_rows: Generated<number>; errors: Generated<Json>; created_by: string | null; created_at: Generated<Timestamp>; applied_at: Timestamp | null;
}
export interface MigrationRowsTable {
  id: Generated<number>; batch_id: string; row_number: number; source_id: string | null; raw: Json; normalized: Json | null; status: Generated<string>; error: string | null; target_id: string | null;
}
export interface ReconciliationRunsTable {
  id: Generated<string>; period_start: DateCol; period_end: DateCol; status: Generated<string>; summary: Json; findings: Generated<Json>; created_at: Generated<Timestamp>;
}

export interface DB {
  roles: RolesTable; permissions: PermissionsTable; role_permissions: RolePermissionsTable; users: UsersTable; user_roles: UserRolesTable; api_keys: ApiKeysTable; audit_logs: AuditLogsTable;
  cost_centers: CostCentersTable; departments: DepartmentsTable; designations: DesignationsTable; projects: ProjectsTable; sites: SitesTable; holidays: HolidaysTable;
  employees: EmployeesTable; employee_status_history: EmployeeStatusHistoryTable; employment_history: EmploymentHistoryTable; employee_contracts: EmployeeContractsTable; employee_documents: EmployeeDocumentsTable;
  salary_components: SalaryComponentsTable; employee_salary_structures: EmployeeSalaryStructuresTable; employee_salary_lines: EmployeeSalaryLinesTable; payroll_policies: PayrollPoliciesTable;
  devices: DevicesTable; device_sites: DeviceSitesTable; biometric_mappings: BiometricMappingsTable; attendance_raw_events: AttendanceRawEventsTable; attendance_corrections: AttendanceCorrectionsTable;
  attendance_events: AttendanceEventsTable; attendance_daily: AttendanceDailyTable; attendance_exceptions: AttendanceExceptionsTable; attendance_ingest_batches: AttendanceIngestBatchesTable;
  shifts: ShiftsTable; shift_rules: ShiftRulesTable; work_patterns: WorkPatternsTable; shift_assignments: ShiftAssignmentsTable;
  leave_types: LeaveTypesTable; leave_policies: LeavePoliciesTable; leave_balances: LeaveBalancesTable; leave_balance_transactions: LeaveBalanceTransactionsTable; leave_requests: LeaveRequestsTable;
  overtime_rules: OvertimeRulesTable; overtime_requests: OvertimeRequestsTable;
  timesheets: TimesheetsTable; timesheet_lines: TimesheetLinesTable; payroll_runs: PayrollRunsTable; payroll_employees: PayrollEmployeesTable; payroll_earnings: PayrollLinesTable;
  payroll_deductions: PayrollLinesTable; payroll_adjustments: PayrollAdjustmentsTable; payslips: PayslipsTable; employee_loans: EmployeeLoansTable;
  workflow_definitions: WorkflowDefinitionsTable; workflow_instances: WorkflowInstancesTable; workflow_tasks: WorkflowTasksTable; notifications: NotificationsTable;
  assets: AssetsTable; employee_assets: EmployeeAssetsTable; checklist_templates: ChecklistTemplatesTable; checklist_instances: ChecklistInstancesTable; checklist_tasks: ChecklistTasksTable;
  integration_connections: IntegrationConnectionsTable; integration_logs: IntegrationLogsTable; integration_failures: IntegrationFailuresTable;
  migration_batches: MigrationBatchesTable; migration_rows: MigrationRowsTable; reconciliation_runs: ReconciliationRunsTable;
}

export type Employee = Selectable<EmployeesTable>;
export type NewEmployee = Insertable<EmployeesTable>;
export type EmployeeUpdate = Updateable<EmployeesTable>;
export type Shift = Selectable<ShiftsTable>;
export type Device = Selectable<DevicesTable>;
export type AttendanceRawEvent = Selectable<AttendanceRawEventsTable>;
export type AttendanceDaily = Selectable<AttendanceDailyTable>;
export type User = Selectable<UsersTable>;
