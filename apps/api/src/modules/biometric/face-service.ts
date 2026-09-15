import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { getEnv } from '@burtplace/config';
import type { DetectedFace, FaceRecognitionProvider } from '../../integrations/face/provider.js';
import { NoneProvider } from '../../integrations/face/provider.js';
import { FaceIndex, decideIdentification, type Candidate } from '../../integrations/face/index-service.js';
import type { FaceSettings } from './settings.js';

/** Provider + index singletons (per API process). The Human module (tfjs-node) is imported lazily on first use. */
let provider: FaceRecognitionProvider | null = null;
let index: FaceIndex | null = null;
export async function faceProvider(): Promise<FaceRecognitionProvider> {
  if (provider) return provider;
  const env = getEnv();
  if (env.FACE_PROVIDER === 'none') provider = new NoneProvider();
  else { const { HumanProvider } = await import('../../integrations/face/human.provider.js'); provider = new HumanProvider(); }
  return provider;
}
export async function faceIndex(app: FastifyInstance): Promise<FaceIndex> {
  if (!index) index = new FaceIndex(app.db, await faceProvider());
  return index;
}
export function invalidateFaceIndex(): void { index?.invalidate(); }
export function resetFaceSingletons(): void { provider = null; index = null; }

export type FrameOutcome = 'OK' | 'NO_FACE' | 'MULTIPLE_FACES' | 'QUALITY_FAILED' | 'LIVENESS_FAILED';
export interface FrameAnalysis { outcome: FrameOutcome; reason: string | null; face: DetectedFace | null; quality: Record<string, unknown> }

/** Decode base64 data-URL or plain base64 into bytes; enforce a size cap (1.5 MB). */
export function decodeImage(b64: string): Buffer {
  const raw = b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64;
  const buf = Buffer.from(raw, 'base64');
  if (buf.length < 500) throw Object.assign(new Error('Image too small'), { statusCode: 400 });
  if (buf.length > 1_500_000) throw Object.assign(new Error('Image too large (max 1.5 MB)'), { statusCode: 413 });
  return buf;
}

/** Run detection + quality + liveness gates on one submitted frame. `purpose` controls the yaw tolerance. */
export async function analyzeFrame(image: Buffer, cfg: FaceSettings, purpose: 'ENROLL' | 'RECOGNIZE'): Promise<FrameAnalysis> {
  const p = await faceProvider();
  let faces: DetectedFace[];
  try { faces = await p.detectFaces(image, { maxFaces: 3, minDetectionConfidence: 0.5 }); }
  catch (err) {
    // Undecodable / corrupt image data is a client error, never a server fault
    const msg = err instanceof Error ? err.message : String(err);
    if (/decode|image|jpeg|png|format|unsupported|invalid|expected/i.test(msg) || (err as { code?: string })?.code === 'FACE_DECODE') throw Object.assign(new Error('Image could not be decoded (expected JPEG/PNG)'), { statusCode: 422 });
    throw err;
  }
  if (faces.length === 0) return { outcome: 'NO_FACE', reason: 'No face detected', face: null, quality: {} };
  if (faces.length > 1) {
    // One person at a time: a second face bigger than 60% of the largest is treated as multiple subjects.
    const sorted = [...faces].sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height);
    if ((sorted[1]!.box.width * sorted[1]!.box.height) / (sorted[0]!.box.width * sorted[0]!.box.height) > 0.6) return { outcome: 'MULTIPLE_FACES', reason: 'More than one face in view', face: null, quality: { faces: faces.length } };
    faces.splice(0, faces.length, sorted[0]!);
  }
  const f = faces[0]!;
  const t = cfg.thresholds;
  const quality: Record<string, unknown> = { score: f.score, faceWidth: f.box.width, faceHeight: f.box.height, yaw: f.rotation?.yaw ?? null, pitch: f.rotation?.pitch ?? null, roll: f.rotation?.roll ?? null, antispoof: f.antispoof, liveness: f.liveness, imageWidth: f.quality.imageWidth, imageHeight: f.quality.imageHeight };
  if (f.score < t.faceQuality) return { outcome: 'QUALITY_FAILED', reason: `Face quality ${f.score.toFixed(2)} below ${t.faceQuality}`, face: f, quality };
  if (Math.min(f.box.width, f.box.height) < t.minFaceSizePx) return { outcome: 'QUALITY_FAILED', reason: 'Move closer to the camera', face: f, quality };
  const maxYaw = purpose === 'ENROLL' ? t.enrollMaxYawRad : t.maxYawRad;
  if (f.rotation && Math.abs(f.rotation.yaw) > maxYaw) return { outcome: 'QUALITY_FAILED', reason: 'Look straight at the camera', face: f, quality };
  if (cfg.liveness.required) {
    if (f.antispoof === null || f.liveness === null) return { outcome: 'LIVENESS_FAILED', reason: 'Liveness could not be assessed', face: f, quality };
    if (f.antispoof < t.antispoof) return { outcome: 'LIVENESS_FAILED', reason: 'Unable to verify live person (anti-spoof)', face: f, quality };
    if (f.liveness < t.liveness) return { outcome: 'LIVENESS_FAILED', reason: 'Unable to verify live person (liveness)', face: f, quality };
  }
  return { outcome: 'OK', reason: null, face: f, quality };
}

export async function identify(app: FastifyInstance, embedding: Float32Array, cfg: FaceSettings): Promise<ReturnType<typeof decideIdentification> & { candidates: Candidate[] }> {
  const cands = await (await faceIndex(app)).search(embedding, 3);
  return { ...decideIdentification(cands, { matchThreshold: cfg.thresholds.match, ambiguityMargin: cfg.thresholds.ambiguityMargin }), candidates: cands };
}

/** Recognition ticket: HMAC-signed proof that the SERVER identified `employeeId` at `iat` in `mode` on `terminalId`. The browser can only replay it, never forge it. */
export interface Ticket { employeeId: string; mode: string; terminalId: string | null; siteId: string | null; eventId: number; iat: number; exp: number; score: number; live: number; spoof: number }
const secret = () => createHmac('sha256', getEnv().API_KEY_PEPPER).update('face-ticket').digest();
export function signTicket(t: Ticket): string {
  const body = Buffer.from(JSON.stringify(t)).toString('base64url');
  const mac = createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}
export function verifyTicket(token: string): Ticket | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expect = createHmac('sha256', secret()).update(body).digest('base64url');
  if (expect.length !== mac.length || !timingSafeEqual(Buffer.from(expect), Buffer.from(mac))) return null;
  try { const t = JSON.parse(Buffer.from(body, 'base64url').toString()) as Ticket; return Date.now() / 1000 > t.exp ? null : t; } catch { return null; }
}
