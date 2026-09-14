import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { createDb, type Database } from '@burtplace/database';
import type pg from 'pg';

declare module 'fastify' {
  interface FastifyInstance { db: Database; pgPool: pg.Pool }
}

export default fp(async function dbPlugin(app: FastifyInstance, opts: { connectionString: string; max?: number }) {
  const { db, pool } = createDb({ connectionString: opts.connectionString, max: opts.max });
  app.decorate('db', db);
  app.decorate('pgPool', pool);
  app.addHook('onClose', async () => { await db.destroy(); });
});
