import { canonicalizeDecimal } from '@/domain/decimal.ts';
import { HivemindError } from '@/domain/errors.ts';
import { readTime } from '@/domain/time.ts';

export type Sql = {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(text: string): Promise<unknown>;
};

export type SqlDatabase = {
  transaction<T>(work: (sql: Sql) => Promise<T>): Promise<T>;
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(text: string): Promise<unknown>;
};

export type Row = Record<string, unknown>;

export async function run(sql: Sql, text: string, params: unknown[]): Promise<void> {
  await sql.query(text, params);
}

export async function one(sql: Sql, text: string, params: unknown[]): Promise<Row | null> {
  const rows = await many(sql, text, params);
  const row = rows[0];

  if (row === undefined) return null;
  if (rows.length > 1) {
    throw new HivemindError('unavailable', 'The query returned more than one row.');
  }

  return row;
}

export async function many(sql: Sql, text: string, params: unknown[]): Promise<Row[]> {
  const result = await sql.query<Row>(text, params);

  return result.rows;
}

export async function readCount(sql: Sql, text: string): Promise<number> {
  const row = await one(sql, text, []);

  return readNumber(row ?? {}, 'count');
}

export function readScalarRecord(value: unknown): Record<string, string | number | boolean | null> {
  if (!isRecord(value)) throw unreadable();

  const data: Record<string, string | number | boolean | null> = {};

  for (const [key, item] of Object.entries(value)) {
    if (
      typeof item === 'string' ||
      typeof item === 'number' ||
      typeof item === 'boolean' ||
      item === null
    ) {
      data[key] = item;
      continue;
    }

    throw unreadable();
  }

  return data;
}

export function readStringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw unreadable();

  return value;
}

export function readString(row: Row, key: string): string {
  const value = row[key];

  if (typeof value !== 'string') throw unreadable();

  return value;
}

export function readNullableString(row: Row, key: string): string | null {
  const value = row[key];

  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw unreadable();

  return value;
}

export function readNullableTime(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  return readTime(value);
}

export function readNumber(row: Row, key: string): number {
  const value = row[key];

  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);

  throw unreadable();
}

export function readMoney(row: Row, key: string): string {
  const value = row[key];

  if (typeof value === 'number' || typeof value === 'string')
    return canonicalizeDecimal(String(value));

  throw unreadable();
}

export function readJson(row: Row, key: string): unknown {
  const value = row[key];

  if (typeof value === 'string') return JSON.parse(value);

  return value;
}

export function json(value: unknown): string {
  return JSON.stringify(value);
}

export function isRecord(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function unreadable(): HivemindError {
  return new HivemindError('unavailable', 'The database returned a row the service cannot read.');
}
