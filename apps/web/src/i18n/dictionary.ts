export type Locale = 'en' | 'ar';
export const dict = {
  en: {
    appName: 'Burtplace Workforce', dashboard: 'Dashboard', employees: 'Employees', attendance: 'Attendance', shifts: 'Shifts', leave: 'Leave', overtime: 'Overtime', timesheets: 'Timesheets', payroll: 'Payroll',
    approvals: 'Approvals', devices: 'Devices', organization: 'Organization', reports: 'Reports', settings: 'Settings', audit: 'Audit trail', search: 'Search', searchHint: 'Search employees, sites, documents…',
    signIn: 'Sign in', signOut: 'Sign out', email: 'Email', password: 'Password', remember: 'Keep me signed in', signInMicrosoft: 'Sign in with Microsoft', welcome: 'Welcome back', loading: 'Loading…', noData: 'Nothing here yet',
    present: 'Present', absent: 'Absent', late: 'Late', onLeave: 'On leave', headcount: 'Headcount', overtimeHours: 'Overtime hours', projects: 'Projects', sites: 'Sites', labourCost: 'Labour cost',
    darkMode: 'Dark mode', language: 'Language', myProfile: 'My profile', pendingApprovals: 'Pending approvals', exceptions: 'Exceptions', today: 'Today', thisMonth: 'This month',
    save: 'Save', cancel: 'Cancel', create: 'Create', approve: 'Approve', reject: 'Reject', export: 'Export', filters: 'Filters', all: 'All', status: 'Status', actions: 'Actions',
  },
  ar: {
    appName: 'بيرتبليس للقوى العاملة', dashboard: 'لوحة التحكم', employees: 'الموظفون', attendance: 'الحضور', shifts: 'الورديات', leave: 'الإجازات', overtime: 'العمل الإضافي', timesheets: 'كشوف الدوام', payroll: 'الرواتب',
    approvals: 'الموافقات', devices: 'الأجهزة', organization: 'الهيكل التنظيمي', reports: 'التقارير', settings: 'الإعدادات', audit: 'سجل التدقيق', search: 'بحث', searchHint: 'ابحث عن موظف، موقع، مستند…',
    signIn: 'تسجيل الدخول', signOut: 'تسجيل الخروج', email: 'البريد الإلكتروني', password: 'كلمة المرور', remember: 'تذكرني', signInMicrosoft: 'الدخول عبر مايكروسوفت', welcome: 'مرحباً بعودتك', loading: 'جارٍ التحميل…', noData: 'لا توجد بيانات',
    present: 'حاضر', absent: 'غائب', late: 'متأخر', onLeave: 'في إجازة', headcount: 'عدد الموظفين', overtimeHours: 'ساعات إضافية', projects: 'المشاريع', sites: 'المواقع', labourCost: 'تكلفة العمالة',
    darkMode: 'الوضع الداكن', language: 'اللغة', myProfile: 'ملفي', pendingApprovals: 'موافقات معلقة', exceptions: 'استثناءات', today: 'اليوم', thisMonth: 'هذا الشهر',
    save: 'حفظ', cancel: 'إلغاء', create: 'إنشاء', approve: 'موافقة', reject: 'رفض', export: 'تصدير', filters: 'تصفية', all: 'الكل', status: 'الحالة', actions: 'إجراءات',
  },
} as const;
export type TKey = keyof typeof dict.en;
