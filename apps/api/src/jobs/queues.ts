import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';

export type JobName = 'attendance.processAffected' | 'attendance.processRange' | 'attendance.reconcile' | 'timesheets.generate' | 'leave.accrual' | 'documents.expiryScan' | 'devices.healthScan' | 'biometric.sync' | 'payroll.calculate';
export interface JobPayloads {
  'attendance.processAffected': { pairs: { employeeId: string; date: string }[] };
  'attendance.processRange': { from: string; to: string; employeeIds?: string[] };
  'attendance.reconcile': { from: string; to: string };
  'timesheets.generate': { year: number; month: number };
  'leave.accrual': { year: number; month: number };
  'documents.expiryScan': Record<string, never>;
  'devices.healthScan': Record<string, never>;
  'biometric.sync': Record<string, never>;
  'payroll.calculate': { runId: string };
}

const QUEUE = 'burtplace';

/**
 * Queue facade. When disabled (tests / no Redis), jobs run inline through the same handlers so behaviour is identical.
 * Every job: retry ×5 with exponential backoff, failed jobs are kept (dead letter) and surfaced in integration_failures.
 */
export class JobQueues {
  private queue: Queue | null = null;
  private connection: Redis | null = null;
  readonly enabled: boolean;
  constructor(private readonly opts: { redisUrl: string; enabled: boolean; app: FastifyInstance }) {
    this.enabled = opts.enabled;
    if (opts.enabled) {
      this.connection = new Redis(opts.redisUrl, { maxRetriesPerRequest: null, enableOfflineQueue: true, lazyConnect: true });
      this.connection.on('error', (e: Error) => opts.app.log.warn({ err: e }, 'redis error'));
      this.queue = new Queue(QUEUE, { connection: this.connection, defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 1000, removeOnFail: false } });
    }
  }

  async add<N extends JobName>(name: N, payload: JobPayloads[N], opts: { jobId?: string; delay?: number } = {}): Promise<string> {
    if (this.queue) {
      try {
        const job = await this.queue.add(name, payload, { jobId: opts.jobId, delay: opts.delay });
        return job.id ?? name;
      } catch (e) {
        this.opts.app.log.error({ err: e }, 'queue unavailable; running job inline');
      }
    }
    const { runJob } = await import('./handlers.js');
    await runJob(this.opts.app, name, payload);
    return `inline:${name}`;
  }

  async enqueueProcessAffected(pairs: { employeeId: string; date: string }[]): Promise<boolean> {
    if (!pairs.length) return false;
    await this.add('attendance.processAffected', { pairs });
    return true;
  }
  async enqueueProcessRange(from: string, to: string, employeeIds?: string[]): Promise<string> {
    return this.add('attendance.processRange', { from, to, employeeIds });
  }

  /** Register repeatable (cron) jobs. Called by the worker process only. */
  async scheduleRepeatables(): Promise<void> {
    if (!this.queue) return;
    const tz = 'Asia/Dubai';
    await this.queue.add('attendance.processRange', { from: 'yesterday', to: 'today' }, { repeat: { pattern: '15 */2 * * *', tz }, jobId: 'cron-attendance' });
    await this.queue.add('attendance.reconcile', { from: 'month-start', to: 'today' }, { repeat: { pattern: '0 3 * * *', tz }, jobId: 'cron-reconcile' });
    await this.queue.add('timesheets.generate', { year: 0, month: 0 }, { repeat: { pattern: '30 3 * * *', tz }, jobId: 'cron-timesheets' });
    await this.queue.add('leave.accrual', { year: 0, month: 0 }, { repeat: { pattern: '0 1 1 * *', tz }, jobId: 'cron-accrual' });
    await this.queue.add('documents.expiryScan', {}, { repeat: { pattern: '0 7 * * *', tz }, jobId: 'cron-documents' });
    await this.queue.add('devices.healthScan', {}, { repeat: { pattern: '*/10 * * * *', tz }, jobId: 'cron-devices' });
    await this.queue.add('biometric.sync', {}, { repeat: { pattern: '*/5 * * * *', tz }, jobId: 'cron-biometric' });
  }

  createWorker(concurrency = 2): Worker | null {
    if (!this.connection) return null;
    const app = this.opts.app;
    const worker = new Worker(QUEUE, async (job: Job) => {
      const { runJob } = await import('./handlers.js');
      return runJob(app, job.name as JobName, job.data);
    }, { connection: this.connection, concurrency });
    worker.on('failed', async (job, err) => {
      app.log.error({ jobId: job?.id, name: job?.name, err }, 'job failed');
      if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
        await app.db.insertInto('integration_failures').values({ operation: `job:${job.name}`, payload: JSON.stringify(job.data), error: err.message, attempts: job.attemptsMade }).execute().catch(() => {});
      }
    });
    return worker;
  }

  async close(): Promise<void> {
    await this.queue?.close().catch(() => {});
    await this.connection?.quit().catch(() => {});
  }
}
