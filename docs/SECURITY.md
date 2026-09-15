# Security

| Control | Implementation |
|---|---|
| SSO / MFA | Microsoft Entra ID access tokens validated against the tenant JWKS (issuer + audience). MFA is enforced by Entra conditional access. `AUTH_MODE=local` is refused in production. |
| Service accounts | API keys (`bpw_…`) stored as `sha256(pepper + key)`; prefix kept for identification; revocable, optional expiry, last-used tracking. |
| RBAC | Permission matrix seeded in DB; route `preHandler` checks + data scoping (all/team/own) in services. Salary & banking are separate permissions. |
| Audit | Append-only `audit_logs` (DB trigger blocks UPDATE/DELETE): who, what, when, old/new (sensitive fields masked), reason, IP, user agent, request id, approval reference. |
| Immutable ledger | `attendance_raw_events` guard trigger; corrections are separate approval-backed rows. |
| Input validation | Zod schemas on every route (params/query/body) + response serialisation; typed SQL via Kysely (parameterised) — no string-built SQL with user input. |
| Rate limiting | 600 req/min per IP (login 10/min); API-key traffic exempt from the global limiter. |
| Headers / CORS | helmet; CORS restricted to `CORS_ORIGINS`; tokens never in URLs. |
| Secrets | Only from environment; `.env` git-ignored; `.env.example` documents every variable. |
| Transport | TLS terminates at the reverse proxy / ingress (deployment); `trustProxy` enabled. |
| Data at rest | PostgreSQL volume encryption at the infrastructure layer (cloud disk / LUKS); object storage SSE. Application-level field encryption for IBAN can be added if required by policy. |
| Biometrics (Matrix) | No templates stored or transferred by design. |
| Biometrics (mobile face attendance) | Face templates AES-256-GCM encrypted (`BIOMETRIC_TEMPLATE_KEY`; dev-only derived key logs a warning), never exposed by any endpoint/search/export; server-side 1:N identification + anti-spoof/liveness + active challenge; browser-supplied identity/scores never trusted — punches need an HMAC ticket bound to employee/mode/terminal/time (90 s); kiosks authenticate with hashed device tokens from one-time pairing codes; append-only `face_recognition_events` with scores only; retention/deletion configurable and **REQUIRES HR/LEGAL APPROVAL** (docs/MOBILE-FACE-ATTENDANCE.md). |
| File uploads | Documents go to S3-compatible storage via pre-signed upload; store object key + MIME + size. AV scanning hook: `REQUIRES CONFIRMATION` of the organisation's scanner (ClamAV / Defender for Storage). |
| Backups | PostgreSQL PITR (WAL archiving) + nightly logical dump; object storage versioning. Restore drills recommended quarterly. |
| Locked payroll | Post-lock changes only via approved adjustments; every transition audited. |

## Known gaps to close before production

1. Field-level encryption for bank details (currently protected by RBAC + audit only).
2. Redis-backed rate limiter for multi-replica deployments.
3. Pre-signed upload endpoint + AV scan integration for documents.
4. Entra group → role mapping automation.
5. `BIOMETRIC_TEMPLATE_KEY` provisioning (KMS/secret store) and HR/Legal approval of the biometric consent & retention policy before enabling mobile face attendance in production.
