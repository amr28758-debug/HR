-- 0011: reporting views

CREATE VIEW v_employee_directory AS
SELECT
  e.id, e.employee_no, e.full_name_en, e.full_name_ar, e.status, e.employment_type, e.joining_date,
  e.probation_status, e.probation_end_date, e.contract_end_date, e.mobile, e.work_email, e.photo_object_key,
  e.matrix_user_id, e.is_office_staff,
  d.id AS department_id, d.name AS department_name,
  g.id AS designation_id, g.title AS designation_title,
  s.id AS site_id, s.name AS site_name,
  p.id AS project_id, p.code AS project_code, p.name AS project_name,
  cc.id AS cost_center_id, cc.code AS cost_center_code,
  m.id AS manager_id, m.full_name_en AS manager_name, m.employee_no AS manager_employee_no,
  e.created_at, e.updated_at
FROM employees e
LEFT JOIN departments d ON d.id = e.department_id
LEFT JOIN designations g ON g.id = e.designation_id
LEFT JOIN sites s ON s.id = e.site_id
LEFT JOIN projects p ON p.id = e.project_id
LEFT JOIN cost_centers cc ON cc.id = e.cost_center_id
LEFT JOIN employees m ON m.id = e.manager_employee_id
WHERE e.deleted_at IS NULL;

CREATE VIEW v_document_expiry AS
SELECT
  ed.id, ed.employee_id, e.employee_no, e.full_name_en, ed.document_type, ed.document_number, ed.expiry_date,
  (ed.expiry_date - CURRENT_DATE) AS days_to_expiry,
  CASE WHEN ed.expiry_date < CURRENT_DATE THEN 'EXPIRED'
       WHEN ed.expiry_date <= CURRENT_DATE + ed.reminder_days_before THEN 'EXPIRING'
       ELSE 'VALID' END AS computed_status
FROM employee_documents ed
JOIN employees e ON e.id = ed.employee_id
WHERE ed.deleted_at IS NULL AND e.deleted_at IS NULL AND ed.expiry_date IS NOT NULL;
