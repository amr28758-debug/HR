import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { getEnv } from '@burtplace/config';

/**
 * Face templates are stored as AES-256-GCM ciphertext: iv(12) || tag(16) || data. The key comes from
 * BIOMETRIC_TEMPLATE_KEY (32 bytes hex). In development/test without a key, a key is DERIVED from API_KEY_PEPPER so the
 * feature works locally — production MUST set BIOMETRIC_TEMPLATE_KEY (startup logs a warning otherwise).
 */
let cachedKey: Buffer | null = null;
export function templateKey(): Buffer {
  if (cachedKey) return cachedKey;
  const env = getEnv();
  cachedKey = env.BIOMETRIC_TEMPLATE_KEY ? Buffer.from(env.BIOMETRIC_TEMPLATE_KEY, 'hex') : createHash('sha256').update(`burtplace-biometric-dev-key:${env.API_KEY_PEPPER}`).digest();
  return cachedKey;
}
export function templateKeyIsDerived(): boolean { return !getEnv().BIOMETRIC_TEMPLATE_KEY; }

export function encryptEmbedding(embedding: Float32Array): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', templateKey(), iv);
  const data = Buffer.concat([cipher.update(Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]);
}
export function decryptEmbedding(blob: Buffer, dim: number): Float32Array {
  const iv = blob.subarray(0, 12), tag = blob.subarray(12, 28), data = blob.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', templateKey(), iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = plain.readFloatLE(i * 4);
  return out;
}

/**
 * Multi-sample template: all accepted enrollment samples (plus their average) are stored concatenated in ONE ciphertext
 * (`dim × n` floats). Matching scores an employee by the best sample ("gallery" matching), which is far more robust to
 * pose/lighting than a single averaged vector, at negligible cost (≤ 7 vectors per employee).
 */
export function encryptEmbeddings(list: Float32Array[]): Buffer {
  const dim = list[0]!.length; const all = new Float32Array(dim * list.length);
  list.forEach((e, i) => all.set(e, i * dim));
  return encryptEmbedding(all);
}
export function decryptEmbeddings(blob: Buffer, dim: number): Float32Array[] {
  if (blob.length <= 28) return [];
  const plainLen = blob.length - 28; const n = Math.max(1, Math.floor(plainLen / (dim * 4)));
  const all = decryptEmbedding(blob, dim * n);
  const out: Float32Array[] = [];
  for (let i = 0; i < n; i++) out.push(all.subarray(i * dim, (i + 1) * dim));
  return out;
}

/** Average several L2-normalised embeddings into one template (re-normalised). */
export function averageEmbeddings(list: Float32Array[]): Float32Array {
  const dim = list[0]!.length; const out = new Float32Array(dim);
  for (const e of list) for (let i = 0; i < dim; i++) out[i]! += e[i]!;
  let norm = 0; for (let i = 0; i < dim; i++) { out[i]! /= list.length; norm += out[i]! * out[i]!; }
  norm = Math.sqrt(norm) || 1; for (let i = 0; i < dim; i++) out[i]! /= norm;
  return out;
}
