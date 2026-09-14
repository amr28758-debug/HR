import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, '..', 'migrations');

export interface MigrationRecord {
  name: string;
  applied_at: string;
}

async function ensureTable(client: pg.PoolClient): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now(),
    checksum text NOT NULL
  )`);
}

function checksum(sql: string): string {
  let h = 0;
  for (let i = 0; i < sql.length; i++) h = (Math.imul(31, h) + sql.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

export async function listMigrationFiles(): Promise<string[]> {
  const files = await readdir(MIGRATIONS_DIR);
  return files.filter((f) => f.endsWith('.sql')).sort();
}

/** Apply all pending SQL migrations in order. Each migration runs in its own transaction. */
export async function migrate(pool: pg.Pool, log: (msg: string) => void = () => {}): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(727272)');
    await ensureTable(client);
    const done = new Set((await client.query<MigrationRecord>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const file of await listMigrationFiles()) {
      if (done.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      log(`applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)', [file, checksum(sql)]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727272)').catch(() => {});
    client.release();
  }
  return applied;
}

export async function migrationStatus(pool: pg.Pool): Promise<{ name: string; applied: boolean }[]> {
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const done = new Set((await client.query<MigrationRecord>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    return (await listMigrationFiles()).map((name) => ({ name, applied: done.has(name) }));
  } finally {
    client.release();
  }
}

/** DANGER: drops and recreates the public schema. Dev/test only. */
export async function resetDatabase(pool: pg.Pool): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}
