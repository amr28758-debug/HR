import { getEnv } from '@burtplace/config';
import { createPool, migrate, resetDatabase, seed } from '@burtplace/database';

/** Runs once before the suite: rebuild the TEST database from migrations + seed. */
export default async function setup() {
  const env = getEnv();
  const url = env.DATABASE_URL_TEST ?? env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL_TEST (or DATABASE_URL) must be set for integration tests');
  if (!/test/i.test(url)) throw new Error(`Refusing to reset a database whose name does not contain "test": ${url}`);
  const pool = createPool({ connectionString: url, max: 2 });
  try {
    await resetDatabase(pool);
    await migrate(pool);
    await seed(pool);
  } finally {
    await pool.end();
  }
}
