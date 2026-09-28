/**
 * Минимальный интерфейс SQL-базы — подмножество API Cloudflare D1.
 * D1Database ему соответствует напрямую; для Node (тесты, Docker) — адаптер над node:sqlite.
 */
export type SqlValue = string | number | null;

export interface SqlRunMeta {
  changes?: number;
  last_row_id?: number;
}

export interface SqlStatement {
  bind(...values: SqlValue[]): SqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: SqlRunMeta }>;
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  /** Выполняет выражения последовательно в одной транзакции (как D1 batch). */
  batch<T = Record<string, unknown>>(statements: SqlStatement[]): Promise<Array<{ results: T[] }>>;
}
