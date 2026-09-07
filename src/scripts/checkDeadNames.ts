import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * TD-012 — fails the build if a name on the CH §23.5 dead list appears under
 * src/models/. Run via `npm run check:dead-list`, wired into `npm test`.
 *
 * Only the literal, unambiguous identifiers from the dead list are checked
 * here: `buyer_districts`, `deposit`, `col_source`, `leg1_col`, `leg2_col`,
 * `virtualSku`/`virtual_sku`, `dormancy`, `debtors`. The remaining §23.5
 * items ("a mode column", "a regular/non-regular flag", "active/inactive
 * customer flags") describe *concepts*, not identifiers — a literal text
 * match on words like `mode` or `active` would flag legitimate, unrelated
 * fields (e.g. `Employee.active`, a staff account's own enabled/disabled
 * flag, which has nothing to do with buyer/seller dormancy). Those are
 * enforced by design-review against DATA_MODEL.md instead of by this script.
 *
 * Matching is done on *whole identifier words*, not raw substrings: every
 * identifier in the file is split at camelCase/snake_case boundaries before
 * comparison. A naive substring check on the lowercased file text once
 * flagged `tradePosition` as containing `deposit` (…tra-"deposit"-ion…) —
 * a real false positive caught while building this. Splitting first means
 * `trade_position` never collides with `deposit`, because the underscore
 * inserted at the word boundary breaks the accidental run of letters.
 */
const MODELS_DIR = join(process.cwd(), 'src', 'models');

const FORBIDDEN_PHRASES = [
  'buyer_districts',
  'deposit',
  'col_source',
  'leg1_col',
  'leg2_col',
  'virtual_sku',
  'dormancy',
  'debtors',
];

const IDENTIFIER_PATTERN = /[A-Za-z_][A-Za-z0-9_]*/g;

function toSnakeCase(identifier: string): string {
  return identifier.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function listModelFiles(): string[] {
  return readdirSync(MODELS_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(MODELS_DIR, name));
}

function findForbiddenPhrasesInFile(path: string): string[] {
  const content = readFileSync(path, 'utf8');
  const identifiers = content.match(IDENTIFIER_PATTERN) ?? [];
  const normalized = new Set(identifiers.map(toSnakeCase));

  return FORBIDDEN_PHRASES.filter((phrase) =>
    [...normalized].some((identifier) => identifier.includes(phrase)),
  );
}

function main(): void {
  const violations: Array<{ file: string; names: string[] }> = [];

  for (const file of listModelFiles()) {
    const found = findForbiddenPhrasesInFile(file);
    if (found.length > 0) {
      violations.push({ file, names: found });
    }
  }

  if (violations.length > 0) {
    console.error('Dead-list check failed (TD-012). Names from CH §23.5 found under src/models/:');
    for (const violation of violations) {
      console.error(`  ${violation.file}: ${violation.names.join(', ')}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('Dead-list check passed — no CH §23.5 names found under src/models/.');
}

main();
