import type { Kysely } from 'kysely';
import type { DB } from '@burtplace/database';
import type { FaceRecognitionProvider } from './provider.js';
import { decryptEmbeddings } from './crypto.js';

/**
 * In-memory 1:N face index. ~1,000 employees × ≤7 samples × 1024 floats ≈ 28 MB; a full linear scan is ~7M multiply-adds (< 20 ms),
 * so no vector database is needed at Burtplace's scale (pgvector is not available on the target PostgreSQL; the
 * interface below is the seam to introduce it later without touching callers).
 *
 * The index is loaded lazily, refreshed when templates change (enroll/disable/delete) and re-validated every
 * `maxAgeMs` against the database version counter so multiple API instances converge.
 */
export interface IndexEntry { employeeId: string; employeeNo: string; templateId: string; embeddings: Float32Array[] }
export interface Candidate { employeeId: string; employeeNo: string; templateId: string; similarity: number }

export class FaceIndex {
  private entries: IndexEntry[] = [];
  private loadedAt = 0;
  private stamp = '';
  constructor(private db: Kysely<DB>, private provider: FaceRecognitionProvider, private maxAgeMs = 30_000) {}

  /** Cheap change detector: count + max(updated_at) of ACTIVE templates for this provider/model. */
  private async currentStamp(): Promise<string> {
    const r = await this.db.selectFrom('biometric_face_templates').select((eb) => [eb.fn.countAll<number>().as('n'), eb.fn.max('updated_at').as('m')]).where('status', '=', 'ACTIVE').where('provider', '=', this.provider.code).where('model_version', '=', this.provider.modelVersion).executeTakeFirstOrThrow();
    return `${r.n}|${r.m ? new Date(r.m as any).getTime() : 0}`;
  }

  async ensureLoaded(force = false): Promise<void> {
    const fresh = Date.now() - this.loadedAt < this.maxAgeMs;
    if (!force && fresh && this.loadedAt) return;
    const stamp = await this.currentStamp();
    if (!force && this.loadedAt && stamp === this.stamp) { this.loadedAt = Date.now(); return; }
    const rows = await this.db.selectFrom('biometric_face_templates as t').innerJoin('employees as e', 'e.id', 't.employee_id').select(['t.id', 't.employee_id', 'e.employee_no', 't.embedding_enc', 't.embedding_dim']).where('t.status', '=', 'ACTIVE').where('t.provider', '=', this.provider.code).where('t.model_version', '=', this.provider.modelVersion).where('e.deleted_at', 'is', null).execute();
    this.entries = rows.map((r) => ({ employeeId: r.employee_id, employeeNo: r.employee_no, templateId: r.id, embeddings: decryptEmbeddings(Buffer.from(r.embedding_enc as any), r.embedding_dim) }));
    this.stamp = stamp; this.loadedAt = Date.now();
  }
  invalidate(): void { this.loadedAt = 0; }
  size(): number { return this.entries.length; }

  /** Best similarity of a probe against every stored sample of one entry (gallery matching). */
  private score(probe: Float32Array, e: IndexEntry): number {
    let best = 0;
    for (const s of e.embeddings) { const v = this.provider.similarity(probe, s); if (v > best) best = v; }
    return best;
  }
  /** Top-k candidates by provider similarity (descending). */
  async search(embedding: Float32Array, k = 3): Promise<Candidate[]> {
    await this.ensureLoaded();
    const scored: Candidate[] = new Array(this.entries.length);
    for (let i = 0; i < this.entries.length; i++) { const e = this.entries[i]!; scored[i] = { employeeId: e.employeeId, employeeNo: e.employeeNo, templateId: e.templateId, similarity: this.score(embedding, e) }; }
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, k);
  }
  /** Similarity of an embedding against one employee's active template (1:1 verification / self-test). */
  async verify(embedding: Float32Array, employeeId: string): Promise<number | null> {
    await this.ensureLoaded();
    const e = this.entries.find((x) => x.employeeId === employeeId);
    return e ? this.score(embedding, e) : null;
  }
}

/** Decide the identification outcome from the top candidates and the configured thresholds. */
export function decideIdentification(cands: Candidate[], cfg: { matchThreshold: number; ambiguityMargin: number }): { outcome: 'MATCHED' | 'NO_MATCH' | 'LOW_CONFIDENCE' | 'AMBIGUOUS'; top: Candidate | null; second: Candidate | null } {
  const top = cands[0] ?? null, second = cands[1] ?? null;
  if (!top) return { outcome: 'NO_MATCH', top, second };
  if (top.similarity < cfg.matchThreshold) return { outcome: top.similarity >= cfg.matchThreshold - 0.15 ? 'LOW_CONFIDENCE' : 'NO_MATCH', top, second };
  if (second && second.employeeId !== top.employeeId && second.similarity >= cfg.matchThreshold && top.similarity - second.similarity < cfg.ambiguityMargin) return { outcome: 'AMBIGUOUS', top, second };
  return { outcome: 'MATCHED', top, second };
}
