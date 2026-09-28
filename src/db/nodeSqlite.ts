import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { SqlDatabase, SqlRunMeta, SqlStatement, SqlValue } from './sql.ts';

/**
 * SqlDatabase поверх встроенного node:sqlite (Node ≥ 22.13) — для тестов и Docker-варианта (SPEC §2.3).
 * Поведение приближено к D1: undefined в bind — ошибка, batch — транзакция.
 */
class NodeStatement implements SqlStatement {
  private readonly db: DatabaseSync;
  private readonly sql: string;
  private readonly values: SqlValue[];

  constructor(db: DatabaseSync, sql: string, values: SqlValue[] = []) {
    this.db = db;
    this.sql = sql;
    this.values = values;
  }

  bind(...values: SqlValue[]): SqlStatement {
    values.forEach((v, i) => {
      if (v === undefined) throw new Error(`D1_TYPE_ERROR: undefined bound at position ${i + 1} in: ${this.sql}`);
      if (typeof v === 'boolean') throw new Error(`D1_TYPE_ERROR: boolean bound at position ${i + 1}`);
    });
    return new NodeStatement(this.db, this.sql, values);
  }

  private stmt(): StatementSync {
    return this.db.prepare(this.sql);
  }

  async first<T>(): Promise<T | null> {
    const row = this.stmt().get(...this.values);
    return (row ? { ...row } : null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.stmt().all(...this.values).map((r) => ({ ...r })) as T[] };
  }

  async run(): Promise<{ meta: SqlRunMeta }> {
    const r = this.stmt().run(...this.values);
    return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }

  allSync(): Record<string, unknown>[] {
    return this.stmt().all(...this.values).map((r) => ({ ...r }));
  }
}

export class NodeSqliteDatabase implements SqlDatabase {
  readonly raw: DatabaseSync;

  constructor(path = ':memory:') {
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA foreign_keys = ON;');
    if (path !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL;');
  }

  prepare(sql: string): SqlStatement {
    return new NodeStatement(this.raw, sql);
  }

  async batch<T>(statements: SqlStatement[]): Promise<Array<{ results: T[] }>> {
    this.raw.exec('BEGIN');
    try {
      const out = statements.map((s) => ({ results: (s as NodeStatement).allSync() as T[] }));
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * Применяет миграции из каталога, ведя учёт в той же таблице, что и wrangler (d1_migrations).
   */
  migrate(dir: string): string[] {
    this.raw.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`);
    const applied = new Set(
      this.raw.prepare('SELECT name FROM d1_migrations').all().map((r) => String((r as { name: string }).name)),
    );
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const done: string[] = [];
    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = readFileSync(join(dir, f), 'utf8');
      this.raw.exec('BEGIN');
      try {
        this.raw.exec(sql);
        this.raw.prepare('INSERT INTO d1_migrations(name) VALUES (?)').run(f);
        this.raw.exec('COMMIT');
      } catch (e) {
        this.raw.exec('ROLLBACK');
        throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
      }
      done.push(f);
    }
    return done;
  }

  close(): void {
    this.raw.close();
  }
}
