import { getEnv } from '@burtplace/config';
import { buildApp } from './app.js';

/** Background worker process: BullMQ consumer + cron scheduler. Run alongside the API (`pnpm worker`). */
const env = getEnv();
const app = await buildApp({ env, enableQueues: true, logger: { level: env.LOG_LEVEL } });
await app.ready();
const worker = app.queues.createWorker(Number(process.env.WORKER_CONCURRENCY ?? 2));
if (!worker) { app.log.error('Queues disabled — worker cannot start'); process.exit(1); }
await app.queues.scheduleRepeatables();
app.log.info('Burtplace worker started');
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, async () => { await worker.close(); await app.close(); process.exit(0); });
