'use client';
/**
 * Browser-side face pipeline for the attendance terminal pages.
 *
 * Runs @vladmandic/human (MIT) in the browser for LOCAL GATING ONLY:
 *   - is there exactly one face, big enough, roughly frontal? (so we only upload useful frames)
 *   - active liveness challenge (blink / turn head / open mouth) detected from face-mesh gestures
 *   - a preliminary anti-spoof / liveness score to give instant feedback
 *
 * The browser NEVER computes recognition embeddings and never holds templates: identification, the authoritative
 * anti-spoof/liveness check, geofencing and the punch itself are done by the API (see docs/MOBILE-FACE-ATTENDANCE.md).
 * Models are served from our own origin (/models, copied at build time by scripts/copy-face-models.mjs).
 */
import type { Config, FaceResult, GestureResult, Human as HumanClass } from '@vladmandic/human';

export type Human = HumanClass;
export type Challenge = 'blink' | 'turn' | 'open_mouth';
export const CHALLENGES: Challenge[] = ['blink', 'turn', 'open_mouth'];

export interface LocalFace { faces: number; score: number; box: { x: number; y: number; width: number; height: number }; sizePx: number; yaw: number | null; pitch: number | null; real: number | null; live: number | null; gestures: string[]; frameW: number; frameH: number }

const TFJS_VERSION = '4.22.0'; // version bundled in @vladmandic/human 3.3.6 (wasm binaries fetched only if WebGL is unavailable)
export const FACE_MODEL_BASE = '/models/';

let humanPromise: Promise<Human> | null = null;
export function faceModelsSupported(): boolean { return typeof window !== 'undefined' && typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia; }

/** Load Human once per page. WebGL first; WASM fallback for devices without WebGL2 (older Android WebViews). */
export function loadHuman(onProgress?: (msg: string) => void): Promise<Human> {
  if (humanPromise) return humanPromise;
  humanPromise = (async () => {
    onProgress?.('Loading face models…');
    const mod = await import('@vladmandic/human');
    const Ctor = (mod.Human ?? (mod as unknown as { default: typeof HumanClass }).default) as typeof HumanClass;
    const config: Partial<Config> = {
      debug: false, modelBasePath: FACE_MODEL_BASE, backend: 'webgl', cacheSensitivity: 0, warmup: 'face',
      wasmPath: `https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@${TFJS_VERSION}/dist/`,
      filter: { enabled: true, equalization: false, flip: false },
      face: { enabled: true, detector: { rotation: false, maxDetected: 3, minConfidence: 0.5, return: false }, mesh: { enabled: true }, iris: { enabled: true }, description: { enabled: false }, emotion: { enabled: false }, antispoof: { enabled: true }, liveness: { enabled: true }, attention: { enabled: false } },
      body: { enabled: false }, hand: { enabled: false }, object: { enabled: false }, gesture: { enabled: true }, segmentation: { enabled: false },
    };
    const h = new Ctor(config);
    try { await h.load(); await h.warmup(); } catch (err) {
      onProgress?.('WebGL unavailable — switching to WASM…');
      h.config.backend = 'wasm';
      await h.load(); await h.warmup();
      void err;
    }
    return h;
  })();
  humanPromise.catch(() => { humanPromise = null; });
  return humanPromise;
}

/** Run local detection on the live video element and summarise the dominant face. */
export async function analyzeVideo(h: Human, video: HTMLVideoElement): Promise<LocalFace | null> {
  if (video.readyState < 2 || video.videoWidth === 0) return null;
  const res = await h.detect(video);
  const faces = res.face as FaceResult[];
  if (!faces.length) return { faces: 0, score: 0, box: { x: 0, y: 0, width: 0, height: 0 }, sizePx: 0, yaw: null, pitch: null, real: null, live: null, gestures: [], frameW: video.videoWidth, frameH: video.videoHeight };
  const f = [...faces].sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3])[0]!;
  const gestures = (res.gesture as GestureResult[]).filter((g) => 'face' in g && g.face === faces.indexOf(f)).map((g) => g.gesture as string);
  return { faces: faces.length, score: f.score, box: { x: f.box[0], y: f.box[1], width: f.box[2], height: f.box[3] }, sizePx: Math.min(f.box[2], f.box[3]), yaw: f.rotation?.angle?.yaw ?? null, pitch: f.rotation?.angle?.pitch ?? null, real: f.real ?? null, live: f.live ?? null, gestures, frameW: video.videoWidth, frameH: video.videoHeight };
}

/** Did the current frame satisfy the requested active challenge? */
export function challengeSatisfied(c: Challenge, face: LocalFace): boolean {
  if (c === 'blink') return face.gestures.some((g) => g.startsWith('blink'));
  if (c === 'turn') return face.gestures.some((g) => g === 'facing left' || g === 'facing right') || (face.yaw !== null && Math.abs(face.yaw) > 0.35);
  if (c === 'open_mouth') return face.gestures.some((g) => { const m = /mouth (\d+)% open/.exec(g); return !!m && Number(m[1]) >= 30; });
  return false;
}
export function pickChallenge(exclude?: Challenge | null): Challenge { const pool = CHALLENGES.filter((c) => c !== exclude); return pool[Math.floor(Math.random() * pool.length)]!; }

/** Capture the current video frame as a JPEG data URL, downscaled so uploads stay small (≈ 40–90 KB). */
export function captureFrame(video: HTMLVideoElement, maxWidth = 640, quality = 0.85): string {
  const scale = Math.min(1, maxWidth / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

export type CameraError = 'INSECURE_CONTEXT' | 'NO_MEDIA_DEVICES' | 'PERMISSION_DENIED' | 'NO_CAMERA' | 'IN_USE' | 'UNKNOWN';
/** Open the user-facing camera. Throws a CameraError code so the UI can show the right guidance. */
export async function openCamera(video: HTMLVideoElement, facing: 'user' | 'environment' = 'user'): Promise<MediaStream> {
  if (typeof window !== 'undefined' && !window.isSecureContext) throw new Error('INSECURE_CONTEXT' satisfies CameraError);
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('NO_MEDIA_DEVICES' satisfies CameraError);
  let lastErr: unknown = null;
  // A camera released a moment ago (previous modal / page) can still report NotReadableError on Android — retry briefly.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } } });
      video.srcObject = stream; video.muted = true; video.playsInline = true;
      await video.play();
      return stream;
    } catch (err) {
      lastErr = err;
      const name = (err as DOMException)?.name ?? '';
      if ((name === 'NotReadableError' || name === 'AbortError') && attempt < 3) { await new Promise((r) => setTimeout(r, 500)); continue; }
      break;
    }
  }
  {
    const err = lastErr;
    const name = (err as DOMException)?.name ?? '';
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new Error('PERMISSION_DENIED' satisfies CameraError);
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new Error('NO_CAMERA' satisfies CameraError);
    if (name === 'NotReadableError' || name === 'AbortError') throw new Error('IN_USE' satisfies CameraError);
    throw new Error('UNKNOWN' satisfies CameraError);
  }
}
export function closeCamera(video: HTMLVideoElement | null): void {
  const s = video?.srcObject as MediaStream | null; s?.getTracks().forEach((t) => t.stop()); if (video) video.srcObject = null;
}

export interface GpsFix { latitude: number; longitude: number; accuracyM: number; capturedAt: string; isMocked: boolean | null }
export type GpsError = 'UNSUPPORTED' | 'PERMISSION_DENIED' | 'UNAVAILABLE' | 'TIMEOUT';
/** Watch the device position (high accuracy). The browser cannot tell us whether a fix is mocked — the server judges plausibility. */
export function watchGps(onFix: (fix: GpsFix) => void, onError: (e: GpsError) => void): () => void {
  if (typeof navigator === 'undefined' || !navigator.geolocation) { onError('UNSUPPORTED'); return () => {}; }
  const id = navigator.geolocation.watchPosition(
    (pos) => onFix({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracyM: Math.round(pos.coords.accuracy), capturedAt: new Date(pos.timestamp).toISOString(), isMocked: null }),
    (err) => onError(err.code === 1 ? 'PERMISSION_DENIED' : err.code === 3 ? 'TIMEOUT' : 'UNAVAILABLE'),
    { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}

/** Terminal (kiosk) identity is stored on the device only — never in source code. */
export interface TerminalRecord { token: string; terminal: { id: string; name: string; deviceCode: string; site: { code: string; name: string } | null }; pairedAt: string }
const TERMINAL_KEY = 'bpw.terminal';
export const terminalStore = {
  get: (): TerminalRecord | null => { try { const v = localStorage.getItem(TERMINAL_KEY); return v ? (JSON.parse(v) as TerminalRecord) : null; } catch { return null; } },
  set: (t: TerminalRecord) => { try { localStorage.setItem(TERMINAL_KEY, JSON.stringify(t)); } catch {} },
  clear: () => { try { localStorage.removeItem(TERMINAL_KEY); } catch {} },
};
