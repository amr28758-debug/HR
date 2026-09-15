/**
 * RBAC matrix — single source of truth, seeded into roles/permissions/role_permissions.
 * Permission code format: <resource>:<action>. Scope modifiers (own / team) are enforced in services.
 */
export const PERMISSIONS = [
  // employees
  'employees:read', 'employees:read:team', 'employees:read:own', 'employees:create', 'employees:update', 'employees:delete', 'employees:transition',
  'employees:documents:read', 'employees:documents:write', 'employees:banking:read', 'employees:banking:write',
  // salary (restricted)
  'salary:read', 'salary:read:own', 'salary:write',
  // organization
  'org:read', 'org:write',
  // devices & integrations
  'devices:read', 'devices:write', 'integrations:read', 'integrations:write', 'attendance:ingest',
  // biometric face templates (RESTRICTED) & attendance terminals
  'biometric:read', 'biometric:enroll', 'biometric:delete', 'biometric:test', 'biometric:events:read', 'terminals:manage', 'face:config:write',
  // attendance
  'attendance:read', 'attendance:read:team', 'attendance:read:own', 'attendance:correct', 'attendance:process', 'attendance:exceptions:resolve',
  // shifts
  'shifts:read', 'shifts:write', 'shifts:assign',
  // leave
  'leave:read', 'leave:read:team', 'leave:read:own', 'leave:request:own', 'leave:request:any', 'leave:approve', 'leave:policy:write',
  // overtime
  'overtime:read', 'overtime:read:team', 'overtime:read:own', 'overtime:request', 'overtime:approve', 'overtime:rules:write',
  // timesheets
  'timesheets:read', 'timesheets:read:team', 'timesheets:read:own', 'timesheets:generate', 'timesheets:approve', 'timesheets:lock',
  // payroll
  'payroll:read', 'payroll:run', 'payroll:review:hr', 'payroll:review:finance', 'payroll:approve', 'payroll:lock', 'payroll:pay', 'payroll:adjust', 'payslips:read:own', 'payslips:read',
  // workflows
  'workflows:read', 'workflows:write', 'workflows:act',
  // reports / dashboards
  'reports:hr', 'reports:attendance', 'reports:payroll', 'reports:cost', 'dashboard:executive', 'dashboard:hr', 'dashboard:manager', 'dashboard:payroll',
  // admin
  'users:read', 'users:write', 'roles:write', 'audit:read', 'system:admin', 'assets:read', 'assets:write', 'migration:run',
  // HR operating system
  'jobs:read', 'jobs:write', 'compensation:read', 'compensation:write', 'requests:create:own', 'requests:create:any', 'requests:read', 'requests:read:team', 'requests:read:own',
  'disciplinary:read', 'disciplinary:write', 'performance:read', 'performance:read:team', 'performance:read:own', 'performance:write', 'training:read', 'training:read:own', 'training:write',
  'letters:generate', 'letters:read:own', 'letters:templates:write', 'notes:read', 'notes:write', 'notes:confidential', 'analytics:read', 'config:write', 'delegation:manage', 'bulk:run',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = [...PERMISSIONS];
const EMPLOYEE_SELF: Permission[] = [
  'employees:read:own', 'salary:read:own', 'attendance:read:own', 'leave:read:own', 'leave:request:own', 'overtime:read:own', 'overtime:request',
  'timesheets:read:own', 'payslips:read:own', 'workflows:act', 'requests:create:own', 'requests:read:own', 'performance:read:own', 'training:read:own', 'letters:read:own',
];
const MANAGER_TEAM: Permission[] = [
  ...EMPLOYEE_SELF, 'employees:read:team', 'attendance:read:team', 'leave:read:team', 'leave:approve', 'overtime:read:team', 'overtime:approve',
  'timesheets:read:team', 'timesheets:approve', 'dashboard:manager', 'org:read', 'shifts:read', 'requests:read:team', 'performance:read:team', 'performance:write', 'jobs:read', 'training:read', 'notes:read',
];

export const ROLE_PERMISSIONS: Record<string, { name: string; description: string; permissions: Permission[] }> = {
  SUPER_ADMIN: { name: 'Super Admin', description: 'Full system access', permissions: ALL },
  HR_ADMIN: {
    name: 'HR Admin', description: 'Employee master, documents, attendance corrections, shifts, leave administration',
    permissions: [
      ...EMPLOYEE_SELF, 'employees:read', 'employees:create', 'employees:update', 'employees:transition', 'employees:documents:read', 'employees:documents:write',
      'org:read', 'org:write', 'devices:read', 'attendance:read', 'attendance:correct', 'attendance:process', 'attendance:exceptions:resolve',
      'shifts:read', 'shifts:write', 'shifts:assign', 'leave:read', 'leave:request:any', 'leave:approve', 'leave:policy:write', 'overtime:read', 'overtime:approve',
      'timesheets:read', 'timesheets:generate', 'timesheets:approve', 'workflows:read', 'workflows:act', 'reports:hr', 'reports:attendance', 'dashboard:hr', 'assets:read', 'assets:write', 'migration:run',
      'jobs:read', 'jobs:write', 'requests:create:any', 'requests:read', 'performance:read', 'performance:write', 'training:read', 'training:write', 'letters:generate', 'notes:read', 'notes:write', 'analytics:read', 'bulk:run', 'compensation:read', 'biometric:read', 'biometric:enroll', 'biometric:test', 'biometric:events:read',
    ],
  },
  HR_MANAGER: {
    name: 'HR Manager', description: 'HR Admin plus salary visibility and payroll HR review',
    permissions: [
      ...EMPLOYEE_SELF, 'employees:read', 'employees:create', 'employees:update', 'employees:delete', 'employees:transition', 'employees:documents:read', 'employees:documents:write',
      'salary:read', 'salary:write', 'org:read', 'org:write', 'devices:read', 'attendance:read', 'attendance:correct', 'attendance:process', 'attendance:exceptions:resolve',
      'shifts:read', 'shifts:write', 'shifts:assign', 'leave:read', 'leave:request:any', 'leave:approve', 'leave:policy:write', 'overtime:read', 'overtime:approve', 'overtime:rules:write',
      'timesheets:read', 'timesheets:generate', 'timesheets:approve', 'timesheets:lock', 'payroll:read', 'payroll:review:hr', 'workflows:read', 'workflows:write', 'workflows:act',
      'reports:hr', 'reports:attendance', 'dashboard:hr', 'dashboard:executive', 'assets:read', 'assets:write', 'audit:read', 'migration:run',
      'jobs:read', 'jobs:write', 'compensation:read', 'compensation:write', 'requests:create:any', 'requests:read', 'disciplinary:read', 'disciplinary:write', 'performance:read', 'performance:write', 'training:read', 'training:write',
      'letters:generate', 'letters:templates:write', 'notes:read', 'notes:write', 'notes:confidential', 'analytics:read', 'config:write', 'delegation:manage', 'bulk:run',
      'biometric:read', 'biometric:enroll', 'biometric:delete', 'biometric:test', 'biometric:events:read', 'terminals:manage', 'face:config:write',
    ],
  },
  PAYROLL_OFFICER: {
    name: 'Payroll Officer', description: 'Runs payroll, manages salary structures and adjustments',
    permissions: [
      ...EMPLOYEE_SELF, 'employees:read', 'employees:banking:read', 'salary:read', 'salary:write', 'org:read', 'attendance:read', 'leave:read', 'overtime:read', 'timesheets:read', 'timesheets:lock',
      'payroll:read', 'payroll:run', 'payroll:adjust', 'payslips:read', 'reports:payroll', 'reports:attendance', 'dashboard:payroll', 'workflows:act', 'compensation:read', 'compensation:write', 'requests:read', 'jobs:read',
    ],
  },
  FINANCE: {
    name: 'Finance', description: 'Payroll finance review, cost reports',
    permissions: [...EMPLOYEE_SELF, 'employees:read', 'employees:banking:read', 'employees:banking:write', 'salary:read', 'org:read', 'timesheets:read', 'payroll:read', 'payroll:review:finance', 'reports:payroll', 'reports:cost', 'dashboard:payroll', 'compensation:read', 'requests:read', 'analytics:read', 'workflows:act'],
  },
  FINANCE_MANAGER: {
    name: 'Finance Manager', description: 'Finance plus payroll approval and payment',
    permissions: [...EMPLOYEE_SELF, 'employees:read', 'employees:banking:read', 'employees:banking:write', 'salary:read', 'org:read', 'timesheets:read', 'payroll:read', 'payroll:review:finance', 'payroll:approve', 'payroll:lock', 'payroll:pay', 'reports:payroll', 'reports:cost', 'dashboard:payroll', 'dashboard:executive', 'workflows:act', 'compensation:read', 'requests:read', 'analytics:read'],
  },
  PROJECT_MANAGER: { name: 'Project Manager', description: 'Sees and approves for project team', permissions: [...MANAGER_TEAM, 'reports:attendance', 'reports:cost'] },
  DEPARTMENT_MANAGER: { name: 'Department Manager', description: 'Sees and approves for department team', permissions: MANAGER_TEAM },
  IT_ADMIN: {
    name: 'IT Admin', description: 'Users, devices, integrations, biometric mapping',
    permissions: [...EMPLOYEE_SELF, 'employees:read', 'org:read', 'users:read', 'users:write', 'devices:read', 'devices:write', 'integrations:read', 'integrations:write', 'attendance:ingest', 'attendance:read', 'attendance:process', 'assets:read', 'assets:write', 'audit:read', 'biometric:read', 'biometric:enroll', 'biometric:test', 'biometric:events:read', 'terminals:manage', 'face:config:write'],
  },
  EMPLOYEE: { name: 'Employee', description: 'Self-service only', permissions: EMPLOYEE_SELF },
  AUDITOR: {
    name: 'Auditor', description: 'Read-only access to everything including audit trail',
    permissions: ALL.filter((p) => p.includes(':read') || p.startsWith('reports:') || p.startsWith('dashboard:') || p === 'audit:read'),
  },
  MANAGEMENT: {
    name: 'Management', description: 'Executive dashboards, final approvals',
    permissions: [...EMPLOYEE_SELF, 'employees:read', 'salary:read', 'org:read', 'attendance:read', 'leave:read', 'overtime:read', 'timesheets:read', 'payroll:read', 'payroll:approve', 'reports:hr', 'reports:attendance', 'reports:payroll', 'reports:cost', 'dashboard:executive', 'dashboard:hr', 'dashboard:payroll', 'workflows:act', 'jobs:read', 'compensation:read', 'requests:read', 'performance:read', 'analytics:read'],
  },
  SERVICE_DEVICE_GATEWAY: { name: 'Service: Device Gateway', description: 'Machine account for device/middleware event push', permissions: ['attendance:ingest', 'devices:read'] },
};
