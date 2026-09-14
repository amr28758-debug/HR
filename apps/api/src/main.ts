import { getEnv } from '@burtplace/config';
import { buildApp } from './app.js';

const env = getEnv();
const app = await buildApp({ env });
try {
  await app.listen({ port: env.API_PORT, host: env.API_HOST });
  app.log.info(`Burtplace Workforce API listening on ${env.API_PUBLIC_URL} (docs at /docs)`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void app.close().then(() => process.exit(0)); });
