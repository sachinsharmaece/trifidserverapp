import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * RECTIFY-01 — what the stop/restart/audit scripts share. Three rules, held in one place:
 *  - a script runs against a database named in the test allow-list, or not at all, unless
 *    `--i-know-this-is-prod` is passed — so a stray `MONGODB_URI` can never be a live one by accident;
 *  - it is a dry run unless `--apply` is passed;
 *  - it writes its report CSV before it writes anything else.
 */

/** Databases a script may touch without `--i-know-this-is-prod`: the test suite's, nothing else. */
export const TEST_DATABASE_ALLOW_LIST: ReadonlySet<string> = new Set(['trifid_test']);

/** The database name in a MongoDB connection string (`mongodb://host/<name>?…`), or ''. */
export function databaseNameOf(uri: string): string {
  const match = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/.exec(uri);
  return match?.[1] ?? '';
}

export function assertDatabaseAllowed(uri: string, iKnowThisIsProd: boolean): void {
  const name = databaseNameOf(uri);
  if (TEST_DATABASE_ALLOW_LIST.has(name) || iKnowThisIsProd) return;
  throw new Error(
    `Refusing to run: database "${name || '(none named)'}" is not in the test allow-list ` +
      `(${[...TEST_DATABASE_ALLOW_LIST].join(', ')}). If it really is the one you mean, ` +
      'pass --i-know-this-is-prod.',
  );
}

/** `--name value` from argv. */
export function argValue(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at > -1 ? argv[at + 1] : undefined;
}

export const hasFlag = (argv: readonly string[], name: string): boolean => argv.includes(name);

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180: one header line, one line per row, a cell quoted when it needs to be. */
export function toCsv(
  columns: readonly string[],
  rows: ReadonlyArray<Record<string, unknown>>,
): string {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((column) => cell(row[column])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** Writes the report (making its folder) and returns the path, so it can be printed. */
export function writeReport(
  path: string,
  columns: readonly string[],
  rows: ReadonlyArray<Record<string, unknown>>,
): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, toCsv(columns, rows), 'utf8');
  return path;
}

/** A filesystem-safe timestamp for report names: 2026-11-09T14-05-33. */
export function stamp(date: Date = new Date()): string {
  return date.toISOString().slice(0, 19).replace(/:/g, '-');
}
