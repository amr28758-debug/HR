import pg from 'pg';
import { Kysely, PostgresDialect, type LogEvent } from 'kysely';
import type { DB } from './schema.js';

const { Pool, types } = pg;

// int8 → number, numeric → number, date → ISO date string (no TZ shift), timestamptz → Date (pg default).
types.setTypeParser(20, (v) => Number(v)); // int8
types.setTypeParser(1082, (v) => v); // date → 'YYYY-MM-DD'
types.setTypeParser(1700, (v) => Number(v)); // numeric → number (money is rounded to 2 dp; safe within 2^53)

export interface CreateDbOptions {
  connectionString: string;
  max?: number;
  log?: (event: LogEvent) => void;
}

export function createPool(opts: CreateDbOptions): pg.Pool {
  return new Pool({ connectionString: opts.connectionString, max: opts.max ?? 20 });
}

export function createDb(opts: CreateDbOptions): { db: Kysely<DB>; pool: pg.Pool } {
  const pool = createPool(opts);
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
    log: opts.log,
  });
  return { db, pool };
}

export type Database = Kysely<DB>;
