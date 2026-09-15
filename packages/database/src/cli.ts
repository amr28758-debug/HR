import { getEnv } from '@burtplace/config';
import { createPool } from './client.js';
import { migrate, migrationStatus, resetDatabase } from './migrator.js';
import { seed } from './seed.js';

async function main() {
  const cmd = process.argv[2] ?? 'migrate';
  const env = getEnv();
  const url = process.env.DATABASE_URL_OVERRIDE ?? env.DATABASE_URL;
  const pool = createPool({ connectionString: url, max: 2 });
  try {
    switch (cmd) {
      case 'migrate': {
        const applied = await migrate(pool, (m) => console.log(m));
        console.log(applied.length ? `applied ${applied.length} migration(s)` : 'database is up to date');
        break;
      }
      case 'status': {
        for (const m of await migrationStatus(pool)) console.log(`${m.applied ? '✔' : '·'} ${m.name}`);
        break;
      }
      case 'seed': {
        await migrate(pool);
        await seed(pool, (m) => console.log(m));
        break;
      }
      case 'ensure': {
        // Idempotent first-run setup used by scripts/start.sh: migrate, then seed only when the database is still empty.
        await migrate(pool, (m) => console.log(m));
        const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM employees`);
        if (Number(rows[0]?.n ?? 0) > 0) console.log(`database already has ${rows[0]!.n} employees — skipping seed`);
        else await seed(pool, (m) => console.log(m));
        break;
      }
      case 'reset': {
        if (env.NODE_ENV === 'production') throw new Error('refusing to reset a production database');
        await resetDatabase(pool);
        await migrate(pool, (m) => console.log(m));
        await seed(pool, (m) => console.log(m));
        break;
      }
      default:
        throw new Error(`unknown command ${cmd}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
