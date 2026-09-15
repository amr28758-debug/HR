/**
 * FaceRecognitionProvider — the ONLY seam between Burtplace Workforce and any face-recognition technology.
 *
 * Core modules (attendance, biometric enrollment) depend on this interface only. The default implementation is
 * `HumanProvider` (@vladmandic/human running server-side on TensorFlow). A cloud/self-hosted engine can replace it by
 * implementing this interface; templates carry `provider` + `modelVersion` so mixed generations never get compared.
 *
 * Honesty rules: a provider must report what it actually computed. If it cannot assess liveness it returns
 * `liveness: null` and the pipeline treats liveness as FAILED when liveness is required by configuration.
 */
export interface DetectedFace {
  /** Detector confidence 0..1 */
  score: number;
  /** Bounding box in source-image pixels */
  box: { x: number; y: number; width: number; height: number };
  /** Head pose in radians (null when mesh disabled) */
  rotation: { yaw: number; pitch: number; roll: number } | null;
  /** Passive anti-spoof classifier: probability that the face is a real capture (not a printed/screen photo). null = not assessed */
  antispoof: number | null;
  /** Liveness classifier: probability that the face is a live person (not replay/deepfake). null = not assessed */
  liveness: number | null;
  /** Face descriptor / embedding (L2-normalised) */
  embedding: Float32Array;
  /** Image-quality indicators computed by the provider */
  quality: { faceWidth: number; faceHeight: number; imageWidth: number; imageHeight: number; sharpness: number | null };
}

export interface DetectOptions { maxFaces?: number; minDetectionConfidence?: number }

export interface FaceRecognitionProvider {
  readonly code: string;           // stored on templates & events (e.g. HUMAN)
  readonly modelVersion: string;   // stored on templates & events (e.g. human-3.3.6/faceres)
  readonly embeddingDim: number;
  /** Load models (idempotent). */
  load(): Promise<void>;
  /** Detect faces in an encoded image (JPEG/PNG bytes) and compute embeddings + liveness signals. */
  detectFaces(image: Buffer, opts?: DetectOptions): Promise<DetectedFace[]>;
  /** Normalised similarity 0..1 between two embeddings (provider-specific metric; 1 = identical). */
  similarity(a: Float32Array, b: Float32Array): number;
  /** Provider-recommended thresholds (documented in docs/MOBILE-FACE-ATTENDANCE.md). */
  recommendedThresholds(): { match: number; antispoof: number; liveness: number; ambiguityMargin: number };
}

/** Provider that refuses every operation — used when FACE_PROVIDER=none so nothing is ever faked. */
export class NoneProvider implements FaceRecognitionProvider {
  readonly code = 'NONE'; readonly modelVersion = 'none'; readonly embeddingDim = 0;
  async load(): Promise<void> { /* nothing */ }
  async detectFaces(): Promise<DetectedFace[]> { throw new Error('Face recognition provider is not configured (FACE_PROVIDER=none)'); }
  similarity(): number { return 0; }
  recommendedThresholds() { return { match: 1, antispoof: 1, liveness: 1, ambiguityMargin: 0 }; }
}
