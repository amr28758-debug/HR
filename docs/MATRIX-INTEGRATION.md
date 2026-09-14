# Matrix ARGO FACE / COSEC VYOM integration

## Principle

Burtplace Workforce owns attendance calculation; the device owns biometric matching. Only `external user id + timestamp + direction + device` crosses the boundary. **No biometric templates are stored or transferred.**

All vendor access goes through `BiometricProvider` (`apps/api/src/integrations/biometric/provider.ts`):

```ts
capabilities(); createUser?; updateUser?; disableUser?; deleteUser?; assignUser?; getUser?;
getAttendanceEvents?(cursor); parseInboundEvents?(payload); getDeviceStatus?; healthCheck();
```

Adapters: `WebhookBiometricProvider` (push, works today), `VyomBiometricProvider` (pull skeleton). Selected by `BIOMETRIC_PROVIDER`.

## Capability matrix

| Capability | Webhook / Device Gateway (Option A) | COSEC VYOM (Option B) |
|---|---|---|
| Create / update / delete / assign / read user | NOT_SUPPORTED (managed on device or vendor software) | **UNKNOWN — REQUIRES VENDOR CONFIRMATION** |
| Read attendance events | OFFICIALLY_DOCUMENTED (Burtplace endpoint) | **UNKNOWN — REQUIRES VENDOR CONFIRMATION** |
| Real-time punch | OFFICIALLY_DOCUMENTED (push) | UNKNOWN |
| Offline punch retrieval | VENDOR_SUPPORTED (gateway replays; idempotent ingest) | UNKNOWN |
| Device status | VENDOR_SUPPORTED (heartbeat endpoint) | UNKNOWN |
| Configuration | NOT_SUPPORTED | UNKNOWN |
| Biometric enrollment | NOT_SUPPORTED by design | NOT_SUPPORTED by design |
| Template transfer | NOT_SUPPORTED by design | NOT_SUPPORTED by design |
| Backup / restore | NOT_SUPPORTED | UNKNOWN |

`GET /api/v1/integrations/biometric/capabilities` returns this matrix live for the active adapter.

## What is confirmed vs. what is not

- **Confirmed / working:** the Burtplace ingest contract (`POST /attendance/events`), fingerprint dedup, replay safety, unmapped-user handling, device heartbeat/health, late mapping with automatic reprocessing.
- **Not confirmed:** whether ARGO FACE terminals can push events directly to an HTTP endpoint (Option A with no middleware), and the COSEC VYOM/CENTRA API for pulling events or managing users. No endpoints have been fabricated; `VyomBiometricProvider.getAttendanceEvents` throws `NotSupportedError` until the official API document is obtained and the adapter is implemented and tested.

## Activation checklist for Option B (VYOM)

1. Obtain the official Matrix COSEC VYOM / CENTRA third-party API or integration document from Matrix / the reseller.
2. Fill in `capabilities()` from the document (status per operation).
3. Implement `getAttendanceEvents(cursor)` with the documented event export (paginated by event id/time), mapping to `ExternalAttendanceEvent`; persist the cursor in `integration_connections.cursor`.
4. Set `BIOMETRIC_PROVIDER=vyom`, `VYOM_*` env vars; set connection `MATRIX_VYOM` to ACTIVE.
5. The worker job `biometric.sync` (every 5 minutes) then pulls, ingests, and queues processing; failures land in `integration_logs` / `integration_failures` with retry and dead-letter.

## Interim path that works now

Export punches from COSEC (scheduled export or middleware) and POST them to `/attendance/events` with the device gateway API key. Because ingestion is idempotent, exports may overlap freely.

## Removing VYOM later

Switch `BIOMETRIC_PROVIDER` to `webhook` (or point the Device Gateway at the same endpoint). Attendance, timesheets and payroll are untouched.
