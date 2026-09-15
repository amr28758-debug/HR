import { createRequire } from 'node:module';
import path from 'node:path';
import { getEnv } from '@burtplace/config';
import type { DetectOptions, DetectedFace, FaceRecognitionProvider } from './provider.js';

/**
 * HumanProvider — @vladmandic/human (MIT) executed SERVER-SIDE on @tensorflow/tfjs-node.
 *
 * Why this library (see docs/MOBILE-FACE-ATTENDANCE.md for the full evaluation):
 *  - runs in the browser (camera gating) AND in Node (trusted server-side scoring) with the same models;
 *  - ships face detection (BlazeFace), mesh/pose, a 1024-d face descriptor (FaceRes), a passive anti-spoof
 *    classifier (`antispoof`, real vs. printed/screen photo) and a liveness classifier (`liveness`);
 *  - no credentials, no per-call cost, models bundled in the npm package (~10 MB for the face set);
 *  - documented similarity semantics: with the default multiplier (20) "similarity above 0.5 can be considered a match".
 *
 * Limits (documented, not hidden): passive single-frame anti-spoof/liveness is weaker than an active or 3D-depth
 * liveness system. The browser adds an active challenge (blink/turn) before capture; both scores are re-computed on the
 * server from the submitted frame and stored on every recognition event.
 */
const require = createRequire(import.meta.url);

export class HumanProvider implements FaceRecognitionProvider {
  readonly code = 'HUMAN';
  readonly modelVersion: string;
  readonly embeddingDim = 1024;
  private human: any | null = null;
  private loading: Promise<void> | null = null;
  constructor() { const { Human } = require('@vladmandic/human'); const probe = new Human({ debug: false, modelBasePath: 'file://./' }); this.modelVersion = `human-${probe.version}/faceres`; }

  async load(): Promise<void> {
    if (this.human) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      process.env.TF_CPP_MIN_LOG_LEVEL ??= '2';
      const { Human } = require('@vladmandic/human'); // resolves to dist/human.node.js (tfjs-node backend)
      const env = getEnv();
      const modelsDir = env.FACE_MODELS_PATH ?? path.join(path.dirname(require.resolve('@vladmandic/human')), '..', 'models');
      const human = new Human({
        modelBasePath: `file://${modelsDir.replace(/\\/g, '/')}/`, backend: 'tensorflow', debug: false, cacheSensitivity: 0,
        face: { enabled: true, detector: { rotation: true, maxDetected: 5, minConfidence: 0.5, return: false }, mesh: { enabled: true }, iris: { enabled: false }, description: { enabled: true }, emotion: { enabled: false }, antispoof: { enabled: true }, liveness: { enabled: true } },
        body: { enabled: false }, hand: { enabled: false }, object: { enabled: false }, gesture: { enabled: false }, filter: { enabled: false },
      });
      await human.load();
      await human.warmup();
      this.human = human;
    })();
    return this.loading;
  }

  async detectFaces(image: Buffer, opts: DetectOptions = {}): Promise<DetectedFace[]> {
    await this.load();
    const h = this.human;
    let tensor: any;
    try { tensor = h.tf.node.decodeImage(image, 3); } catch (err) { throw Object.assign(new Error(`Image decode failed: ${err instanceof Error ? err.message : String(err)}`), { code: 'FACE_DECODE', statusCode: 422 }); }
    try {
      const [height, width] = tensor.shape as [number, number, number];
      const res = await h.detect(tensor, { face: { detector: { maxDetected: opts.maxFaces ?? 5, minConfidence: opts.minDetectionConfidence ?? 0.5 } } });
      return (res.face as any[]).filter((f) => f.embedding?.length).map((f) => ({
        score: Number(f.score ?? f.boxScore ?? 0),
        box: { x: f.box[0], y: f.box[1], width: f.box[2], height: f.box[3] },
        rotation: f.rotation?.angle ? { yaw: f.rotation.angle.yaw, pitch: f.rotation.angle.pitch, roll: f.rotation.angle.roll } : null,
        antispoof: typeof f.real === 'number' ? f.real : null,
        liveness: typeof f.live === 'number' ? f.live : null,
        embedding: Float32Array.from(f.embedding as number[]),
        quality: { faceWidth: f.box[2], faceHeight: f.box[3], imageWidth: width, imageHeight: height, sharpness: null },
      }));
    } finally { tensor.dispose(); }
  }

  similarity(a: Float32Array, b: Float32Array): number {
    // Mirrors @vladmandic/human `match.similarity` exactly (order 2, multiplier 25, min 0.2, max 0.8) so server-side scores
    // equal the library's documented metric ("similarity above 0.5 can be considered a match").
    if (a.length !== b.length || a.length === 0) return 0;
    let sum = 0; for (let i = 0; i < a.length; i++) { const d = a[i]! - b[i]!; sum += d * d; }
    const dist = 25 * sum;
    if (dist === 0) return 1;
    const norm = (1 - Math.sqrt(dist) / 100 - 0.2) / (0.8 - 0.2);
    return Math.round(100 * Math.max(Math.min(norm, 1), 0)) / 100;
  }

  recommendedThresholds() { return { match: 0.5, antispoof: 0.5, liveness: 0.5, ambiguityMargin: 0.05 }; }
}
