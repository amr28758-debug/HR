# Mobile face recognition attendance

A phone or tablet browser acts as a **face-recognition attendance terminal**: the camera identifies the employee
(1:N — no employee number is typed), liveness is verified, the device location is checked against the site geofence,
and the punch enters the **existing immutable raw punch ledger** with source `MOBILE_FACE`. From there the existing
attendance engine, exceptions, timesheets and payroll run unchanged.

> Not used, by design: Apple Face ID / Touch ID, Android biometric prompt, passkeys / WebAuthn. Those prove *the phone
> owner unlocked the phone*, not *which employee is standing at the gate*. Mobile face attendance uses the normal camera and
> a dedicated recognition pipeline so that one shared device can serve many employees.

## 1. Technology decision (evaluated, not assumed)

| Option | Evaluated | Result |
|---|---|---|
| Native OS biometrics (Face ID, Android BiometricPrompt, passkeys) | Rejected by requirement | Authenticates the device owner, never returns a face template, cannot do 1:N |
| Cloud face APIs (Azure Face, AWS Rekognition) | Rejected for this release | Biometric data leaves the premises; contractual/legal review required; network dependency to a third party; **no vendor endpoint is invented or called** |
| Matrix ARGO FACE / COSEC VYOM | Not required | Device-side matching; mobile face attendance is independent of Matrix (`docs/MATRIX-INTEGRATION.md`) |
| `face-api.js` | Rejected | Unmaintained since 2020, no liveness/anti-spoof models |
| **`@vladmandic/human` 3.3.6 (MIT)** | **Selected** | Maintained, ships face detection (BlazeFace), mesh/iris (gestures), **anti-spoof** and **liveness** classifiers and a 1024-d face description embedding (FaceRes). Runs in Node with `@tensorflow/tfjs-node` (native CPU backend, 125–195 ms per frame measured here) and in the browser (WebGL / WASM). Entirely on-prem, no vendor account |

What the library provides — verified by running it on the shipped sample images (`apps/api/test/fixtures`, AI-generated
faces from the library's own repository, MIT):

* detection score, box, rotation (yaw/pitch/roll), 1024-float embedding per face;
* `real` (anti-spoof classifier, 0..1) and `live` (liveness classifier, 0..1) per face;
* similarity formula documented by the library: with the default multiplier "similarity above 0.5 can be considered a match".
  The API reproduces the library's formula exactly (`HumanProvider.similarity`) so thresholds mean the same thing as in the
  vendor documentation.

**Limits (stated honestly):** the anti-spoof / liveness models are *passive, single-frame classifiers*. They are a real
signal, not a certified presentation-attack-detection (ISO 30107-3) system. That is why the **active challenge** (blink /
turn head / open mouth, checked from face-mesh gestures on the device and required by the server) is enabled by default, the
site kiosk is expected to be supervised by a gate guard, and every attempt is logged with its scores for review. A vendor
PAD-certified provider can be plugged in behind the same interface (section 9).

## 2. Architecture

```
Browser (phone / tablet / kiosk)                                 API (on-prem)
────────────────────────────────                                 ─────────────────────────────────────────────────
Human (WebGL/WASM, models from /models)                          FaceRecognitionProvider = HumanProvider (tfjs-node)
  detect one face, size, yaw  ── gating only ──►                 POST /attendance/mobile/recognize {frame,gps,siteCode,clientSignals}
  active challenge (blink/turn/mouth)                              decodeImage → detectFaces → quality gates → anti-spoof/liveness
  capture ONE frontal JPEG (≤640 px, ~60 KB)                       → embedding → FaceIndex.search (1:N, in-memory)
  GPS watchPosition (high accuracy)                                → decideIdentification (threshold, ambiguity margin)
                                                                   → eligibility (status, kiosk site) → geofence → duplicate window
                                                                   → face_recognition_events (immutable) → HMAC ticket (90 s)
  show employee card + suggested IN/OUT   ◄──── ticket ────
  CHECK IN / CHECK OUT                    ── ticket ─────►         POST /attendance/mobile/punch {ticket,direction,gps}
                                                                   verifyTicket → re-check GPS → attendance_exceptions flags
                                                                   → ingestEvents(source=MOBILE_FACE)  ← EXISTING raw ledger
                                                                   → enqueueProcessAffected            ← EXISTING engine
```

* The browser never computes or receives embeddings, never receives thresholds that could let it self-approve, and cannot
  create a punch without a **server-signed ticket** bound to the identified employee, mode, terminal and time.
* `attendance_raw_events` receives `device_code` = terminal device (`MF-<SITE>-xxxx`) or the virtual `MOBILE-WEB` device,
  `external_user_id` = employee number, `verification_method = FACE`, `vendor_payload` = scores / mode / geofence result.
  The existing fingerprint `SHA256(user|ts|dir|device)` keeps idempotency.
* The employee is resolved through `biometric_mappings(provider='MOBILE_FACE', external_user_id=employee_no)`, created at
  enrollment and deactivated on disable/delete/exit — the ledger's existing resolution path.

### Modes

| Mode | URL | Who | Identity of the device | Notes |
|---|---|---|---|---|
| Employee mobile | `/attendance` | anyone with the link (public page) | none — the face is the identity | GPS + geofence required by default; card shows name, number, designation, site |
| Supervisor mobile | `/attendance` while signed in as a supervisor/HR | supervisor device, sequential employees | bearer token → `SUPERVISOR_MOBILE` | "Sequential check-in" auto-resets after each employee |
| Site kiosk | `/kiosk/:siteCode` | shared tablet at the gate | terminal token from one-time pairing (`/kiosk/pair`) | continuous camera, result shown 3–4 s then reset, **no HR data** (name + number only), only employees of that site, GPS off by default (`gps.kioskGpsRequired`) |

### UI state machine

`READY → DETECTING FACE → VERIFYING LIVE PERSON → IDENTIFYING EMPLOYEE → VERIFYING LOCATION → READY TO CHECK IN/OUT → DONE`
plus `FAILED` (with retry) and `OFFLINE` ("Network connection required for attendance verification."). English/Arabic, RTL,
dark/light; camera permission denied, no camera, HTTP (insecure context) and GPS denied all have explicit guidance.

## 3. Enrollment (Employee Command Center → Biometric)

* Performed by a user with `biometric:enroll` **on their own device**; employees can never enroll themselves or others
  (the API refuses `own` enrollment even for HR users, unless they hold `biometric:delete`).
* Three angles are captured automatically from the live camera (straight / slightly left / slightly right) when the pose is
  held steady. Frames are analysed server-side with the same gates as recognition (one face, size, quality, yaw ≤
  `enrollMaxYawRad`, anti-spoof/liveness); every accepted frame must be consistent with the others (min pairwise
  similarity ≥ match threshold — protects against two people in one enrollment) and must **not** match another
  employee's template (duplicate-identity guard).
* Stored: the encrypted embeddings (each accepted sample + their average), sample count, quality metadata (scores,
  angles), consent note, enrolled-by/at. **Not stored:** images, landmarks, or anything reversible to a face.
* Re-enrollment replaces the previous template (old row → `DELETED`, ciphertext wiped). Disable keeps the template but
  stops recognition; Delete is irreversible and audited.

## 4. Matching, thresholds, outcomes

The in-memory `FaceIndex` holds every ACTIVE template for the current provider/model (≈ 1,000 employees × ≤7 vectors ×
1024 floats ≈ 28 MB, full scan < 20 ms); it reloads when templates change (stamp = count + max(updated_at), checked every
30 s, invalidated immediately in-process). **No per-frame database scan.** pgvector was evaluated and is not available on
the target PostgreSQL 16 build; the `FaceIndex` class is the seam if it is introduced later.

Each employee is scored by the best of their stored samples ("gallery" matching). Decision:

| Condition | Outcome | Message |
|---|---|---|
| top ≥ `thresholds.match` and (no 2nd employee ≥ threshold within `ambiguityMargin`) | `MATCHED` | employee card + suggested direction |
| top ≥ threshold but 2nd employee within margin | `AMBIGUOUS` | "Unable to confidently identify employee" |
| threshold − 0.15 ≤ top < threshold | `LOW_CONFIDENCE` | "Face not recognized" (optionally `EXCEPTION`, config) |
| top < threshold − 0.15 or no templates | `NO_MATCH` | "Face not recognized" |
| anti-spoof / liveness below threshold, or active challenge not completed | `LIVENESS_FAILED` | "Unable to verify live person" |
| no face / several faces / too small / turned | `NO_FACE`, `MULTIPLE_FACES`, `QUALITY_FAILED` | guidance |
| status TERMINATED/ARCHIVED, kiosk of another site, mode disabled | `REJECTED` | reason |
| punch inside `duplicateWindowSeconds` | `DUPLICATE` | "Attendance already recorded at …" |

Settings (Administration → Attendance → Face recognition; versioned in `app_settings` with history):

| Setting | Default | Source of default |
|---|---|---|
| `thresholds.match` (FACE_MATCH_THRESHOLD) | 0.50 | Human documentation ("above 0.5 = match" with default multiplier) |
| `thresholds.ambiguityMargin` | 0.05 | company policy |
| `thresholds.antispoof`, `thresholds.liveness` | 0.50 | classifier decision point |
| `thresholds.faceQuality` | 0.80 | detector confidence |
| `thresholds.minFaceSizePx` | 96 px (in the 640-px upload) | FaceRes input is 112 px; below ~96 px accuracy degrades |
| `thresholds.maxYawRad` / `enrollMaxYawRad` | 0.45 / 0.60 rad | ≈ 26° / 34° |
| `liveness.required`, `liveness.activeChallenge`, `challengeTimeoutSeconds` | on / on / 12 s | company policy |
| `gps.required`, `geofenceRequired`, `accuracyLimitM`, `maxFixAgeSeconds`, `kioskGpsRequired` | on / on / 100 m / 90 s / off | company policy |
| `duplicateWindowSeconds` | 120 | company policy |
| `ticketTtlSeconds` | 90 | security |
| `behaviour.*` (unknownFace, lowConfidence, suspiciousGps, outsideGeofence, lowAccuracy) | REJECT / REJECT / EXCEPTION / REJECT / EXCEPTION | company policy |
| `retention.*`, `privacy.*` | see section 7 | **REQUIRES HR/LEGAL APPROVAL** |

Tuning guidance: raise `match` to reduce false accepts (more "Face not recognized"); lower it only with the events log open.
Re-enroll employees whose top scores hover near the threshold (beard, glasses, PPE). Never tune with a single value change
per day untested; the events tab shows top and second scores for every attempt.

## 5. GPS and geofencing

* Browser Geolocation API (HTTPS required), `watchPosition` with high accuracy; the fix (lat/lng/accuracy/timestamp) is sent
  with both requests. Browsers do not expose "mock location"; the server judges plausibility instead.
* Fences: primary = `sites.latitude/longitude/geofence_radius_m` (Organization → Sites), plus any number of
  `site_geofences` rows (yards, camps, gates). An employee is evaluated against their own site and their project's sites;
  a kiosk against its terminal site.
* Accuracy is added as slack to the radius (an honest employee with a ±60 m fix at the fence edge is INSIDE); a fix worse
  than `accuracyLimitM` is `LOW_ACCURACY` (default: record + `LOW_ACCURACY` exception, not rejection).
* Trust indicators → `SUSPICIOUS`: stale fix (older than `maxFixAgeSeconds`), implausible accuracy (< 1 m or exactly 0 with a
  mocked flag), **impossible travel** (> 70 m/s vs the employee's previous punch position). Default behaviour: record the
  punch and open a `LOCATION_SUSPICIOUS` review item (`attendance_exceptions.INVALID_PUNCH` with details) so HR reviews it
  instead of a legitimate worker being turned away at the gate.
* `OUTSIDE` → reject by default (configurable to record + `OUTSIDE_SITE` exception).

## 6. Security

* The browser is untrusted: employee id, scores, site and direction are **never** accepted from it. There is no endpoint
  that takes an employee id to punch. `/attendance/mobile/punch` accepts only a ticket the server signed (HMAC-SHA256 with a
  key derived from `API_KEY_PEPPER`), bound to employee, mode, terminal, site and event id, valid `ticketTtlSeconds`.
* Terminals: `attendance_terminals` rows carry only `sha256(pepper:token)`. IT registers a terminal → 6-digit one-time
  pairing code (24 h) → the kiosk exchanges it once for `bpt_…` which lives in that browser's storage only. Revoke stops the
  token immediately; re-issue rotates it. No secret in the frontend bundle.
* Rate limits: recognize/punch 40 req/min per IP, pairing 10/min; frames capped at 1.5 MB; undecodable images → 422.
* Every attempt is an immutable `face_recognition_events` row (DB trigger forbids update/delete) with scores, geofence
  result, device, IP, user agent and duration — **never embeddings or images**. Punches also go to `audit_logs`.
* Templates: AES-256-GCM (`BIOMETRIC_TEMPLATE_KEY`, 32 bytes hex). Without the key the API derives one from
  `API_KEY_PEPPER` for development and logs a warning — **set the key in production** (rotating it requires re-enrollment;
  a key-wrapping scheme can be added if policy requires).
* RBAC: `biometric:read`, `biometric:enroll`, `biometric:test`, `biometric:delete`, `biometric:events:read`,
  `terminals:manage`, `face:config:write` (`docs/RBAC.md`). Employees see only their own status/events; templates are never
  exposed through any endpoint, search, CSV or report.

## 7. Privacy, retention and legal sign-off (configurable — REQUIRES HR/LEGAL APPROVAL)

The system does **not** assert any UAE legal requirement. The following are configuration values with sensible defaults
that HR/Legal must confirm, and record in `retention.policyApprovedBy`:

| Item | Where | Default |
|---|---|---|
| Consent notice text/version shown to employees before enrollment | `privacy.consentNoticeVersion` | `DRAFT — REQUIRES HR/LEGAL APPROVAL` |
| Consent evidence per enrollment | consent note on the enrollment (free text / form reference) | required in the UI |
| Disable recognition on exit | `retention.disableOnExit` | on (TERMINATED / ARCHIVED → template DISABLED, mapping inactive) |
| Delete templates N days after exit | `retention.deleteAfterExitDays` | null = manual deletion only (nightly job `biometric.retention` when set) |
| Recognition-event retention | `retention.recognitionEventRetentionDays` | 365 |
| Employee's own visibility | Command Center → Biometric (own) | status + own events, never template data |
| Photo on kiosk | `privacy.showPhotoOnKiosk` | off |

## 8. API summary

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /attendance/mobile/config?siteCode=` | public / terminal | runtime config for the page (modes, client gates, GPS policy, terminal/site) |
| `POST /attendance/mobile/terminals/pair` | public, 10/min | `{pairingCode}` → `{token, terminal}` (once) |
| `POST /attendance/mobile/recognize` | public / bearer / terminal, 40/min | `{frame, gps, siteCode, clientSignals}` → outcome, ticket, employee card, suggested direction, geofence |
| `POST /attendance/mobile/punch` | same, 40/min | `{ticket, direction, gps}` → raw event id, flags |
| `GET /biometric/employees/:id/status` | `biometric:read` or own | status, quality metadata, last recognition, history |
| `POST /biometric/employees/:id/enroll` | `biometric:enroll` (not own) | `{frames[1..6], consentNote}` |
| `POST /biometric/employees/:id/test` | `biometric:test` | one frame → verify score + 1:N result, no attendance |
| `POST /biometric/employees/:id/disable` / `enable`, `DELETE …/template?reason=` | `biometric:enroll` / `biometric:delete` | lifecycle |
| `GET /biometric/events` | `biometric:events:read` or own | immutable recognition log |
| `GET/PUT /biometric/settings` | `face:config:write` (read: `biometric:read`) | versioned settings + defaults + provider recommendation |
| `GET/POST /biometric/terminals`, `POST …/:id/revoke`, `POST …/:id/reissue` | `terminals:manage` | kiosks |
| `GET/POST /biometric/geofences`, `PATCH …/:id` | `org:read` / `org:write` | additional fences |

Full schemas: run the API and open `/docs` (tag `biometric`, `attendance`).

## 9. Provider abstraction and replacement

`apps/api/src/integrations/face/provider.ts`:

```ts
interface FaceRecognitionProvider {
  code: string; modelVersion: string; embeddingDim: number;
  load(): Promise<void>;
  detectFaces(image: Buffer, opts?): Promise<DetectedFace[]>;   // score, box, rotation, antispoof, liveness, embedding
  similarity(a: Float32Array, b: Float32Array): number;          // 0..1, higher = more similar
  recommendedThresholds(): { match; antispoof; liveness; ambiguityMargin };
}
```

`FACE_PROVIDER=human` (default) or `none` (feature off, endpoints answer 503 — the dev/mock mode never pretends recognition
works). To add a vendor SDK or a PAD-certified engine: implement the interface, register it in `face-service.ts`, and set
`provider` in the settings. Templates are keyed by `provider + model_version`, so a model change requires re-enrollment
(the index only loads templates of the active model — old ones are ignored, never mis-compared).

## 10. Deployment & operations

* API: `@tensorflow/tfjs-node` builds a native addon on install (`pnpm.onlyBuiltDependencies` in the root `package.json`;
  run `pnpm rebuild @tensorflow/tfjs-node` if the binary is missing). Models load from the package at first use
  (`FACE_MODELS_PATH` to override); the first request warms the provider (~2 s).
* Web: `scripts/copy-face-models.mjs` (pre-dev/pre-build) copies the 5 browser models (~6 MB) to `public/models` — served
  from our origin, no CDN. Only the WASM fallback fetches `tfjs-backend-wasm` from jsdelivr (configurable in
  `face-client.ts`); WebGL is the normal path.
* HTTPS is mandatory (camera + geolocation are blocked on plain HTTP except `localhost`).
* Browser support: Safari iOS 15+, Chrome/Edge Android 90+, desktop Chrome/Edge/Firefox/Safari. In-app browsers (Teams,
  WhatsApp) may block the camera — open in the system browser.
* Kiosk hardware: any Android tablet / iPad in a stand with a front camera at face height, screen always on, browser in
  full-screen/kiosk mode, on the site Wi-Fi/4G. Pair once via `/kiosk/pair`.
* Sizing: recognition ≈ 150–250 ms CPU per request on the API host; 1,000 employees punching within 15 minutes is ~1.1
  requests/s — a single API instance copes; scale API replicas horizontally (the index is per process).
* Offline: recognition needs the server, so the pages show "Network connection required for attendance verification." and
  never queue punches (a queue would have to trust the device's identification). `offline.queueEnabled` is reserved for a
  future on-device provider.

## 11. Tests

`apps/api/test/mobile-face.test.ts` (19 tests, real models): geofence & decision logic; enrollment quality/consistency/
duplicate guard and RBAC; recognition → ticket → punch into the raw ledger; duplicate window; forged/tampered tickets;
GPS outside / low accuracy / mocked / stale behaviours; kiosk registration, pairing, site restriction, revocation;
threshold, liveness and ambiguity outcomes; TERMINATED/ARCHIVED lifecycle; immutable event log without embeddings;
self-test and deletion. Pure engine tests are unaffected (`packages/core`).

## 12. What remains before go-live

1. HR/Legal approval of the consent notice, retention and deletion policy (section 7) and of the site kiosk supervision
   procedure (passive liveness is not PAD-certified).
2. Surveyed site coordinates and radii (seeded values are **examples**).
3. `BIOMETRIC_TEMPLATE_KEY` in the production environment; HTTPS certificates for the web origin.
4. Pilot on one site: enroll, run for two weeks, review the recognition events (false rejects / ambiguity), adjust
   thresholds once, then roll out.
5. Optional: PAD-certified liveness provider behind `FaceRecognitionProvider`; pgvector if the employee base grows well
   beyond 10,000.
