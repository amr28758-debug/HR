# Attendance engine

Pure functions in `packages/core/src/{shift-engine,attendance-engine,timesheet}.ts` (47 unit tests). The API binds them to the database in `apps/api/src/modules/attendance/processor.service.ts`.

## Pipeline

```
Device / Gateway / VYOM
  → POST /attendance/events           fingerprint = SHA256(user|ts|dir|device); ON CONFLICT DO NOTHING
Mobile face terminal (phone / tablet / kiosk, source MOBILE_FACE — docs/MOBILE-FACE-ATTENDANCE.md)
  → POST /attendance/mobile/recognize  server-side 1:N face identification + liveness + GPS geofence → signed ticket
  → POST /attendance/mobile/punch      ticket → ingestEvents() — same fingerprint, same ledger, same engine below
  → attendance_raw_events (immutable) resolves device→site, user→employee (else UNMAPPED_USER exception)
  → processEmployeeDay(employee, date)
      schedule = resolveSchedule(assignments employee>project>site, work pattern week-offs, holidays)
      punches  = raw events in [scheduledStart − earlyInWindow, scheduledEnd + lateOutWindow] not claimed by previous day's window
               + approved corrections (ADD_PUNCH / IGNORE_PUNCH / CHANGE_DIRECTION / OVERRIDE_DAY)
      leave    = approved leave request covering the date
      result   = calculateDay(...)
  → attendance_daily (upsert), attendance_events (rebuilt), attendance_exceptions (open/auto-resolve)
  → timesheets (monthly aggregate) → payroll
```

## Day rules (all values from the shift definition)

| Situation | Result |
|---|---|
| Date < joining or > last working date | `NOT_YET_JOINED` / `EXITED`, unpaid |
| Approved full-day leave | `ON_LEAVE`, paid per leave type, punches ignored for pay |
| Week-off or public holiday | `WEEK_OFF` / `PUBLIC_HOLIDAY`, paid; any presence − unpaid break → `weekendMinutes`/`holidayMinutes` and OT candidate (rounded down to `otRoundingMinutes`, dropped below `otMinBlockMinutes`) |
| No assignment | `UNSCHEDULED` (or `PRESENT` if punches) — no absence logic |
| Working day, no punches | `ABSENT`, unpaid, exception HIGH |
| Odd punch count | `MISSING_PUNCH`, paid pending correction, `MISSING_IN/OUT` exception; lateness still computed |
| Full span | presence = lastOut − firstIn; worked = presence − unpaid break (if presence > break) |
| Late | firstIn − scheduledStart, counted **in full** when > `graceInMinutes` |
| Early leave | scheduledEnd − lastOut when > `graceOutMinutes` |
| Half day | worked < `halfDayThresholdMinutes` → `HALF_DAY` (0.5 present / 0.5 absent) |
| Absent by threshold | worked ≤ `absentThresholdMinutes` → `ABSENT` |
| Overtime | `min(worked − otAfter, minutesAfterScheduledEnd)` (or `worked − otAfter` when `countEarlyInAsOt`), rounded down, min block, max/day → `EXCESSIVE_OT`; `UNAPPROVED_OT` until approved |
| Half-day leave | required minutes halved; leave reference kept |
| Duplicate punches | within `duplicateWindowMinutes` (2) → ignored + `DUPLICATE_PUNCH` |
| Direction | device IN/OUT trusted when configured or when a CHANGE_DIRECTION correction exists; otherwise alternation |
| Site mismatch | punch site ≠ employee site → `OUTSIDE_SITE` |

## Cross-midnight shifts

`end_time <= start_time` marks the shift as crossing midnight. A punch is attributed to the earlier business date whose window contains it, so a 02:00 punch belongs to yesterday's night shift and today's window excludes it.

## Corrections & locking

Raw punches are never modified. HR submits an `attendance_corrections` row (reason mandatory) that runs the `ATTENDANCE_CORRECTION` workflow (Manager → HR); on approval the day is recalculated. Days inside a LOCKED timesheet are never recalculated; changes go through payroll adjustments.

## Reconciliation

`POST /attendance/reconcile` compares raw → processed → daily → timesheet → payroll and stores findings (`reconciliation_runs`): unprocessed raw events, unmapped users, employees missing daily rows, timesheet/daily mismatches, payroll/timesheet OT mismatches. Runs nightly via the worker.
