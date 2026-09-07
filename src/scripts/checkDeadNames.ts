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
 */
const MODELS_DIR = join(process.cwd(), 'src', 'models');

const FORBIDDEN_NAMES = [
  'buyer_districts',
  'buyerDistricts',
  'deposit',
  'col_source',
  'colSource',
  'leg1_col',
  'leg1Col',
  'leg2_col',
  'leg2Col',
  'virtual_sku',
  'virtualSku',
  'dormancy',
  'debtors',
];

function listModelFiles(): string[] {
  return readdirSync(MODELS_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(MODELS_DIR, name));
}

function checkFile(path: string): string[] {
  const content = readFileSync(path, 'utf8').toLowerCase();
  return FORBIDDEN_NAMES.filter((name) => content.includes(name.toLowerCase()));
}

function main(): void {
  const violations: Array<{ file: string; names: string[] }> = [];

  for (const file of listModelFiles()) {
    const found = checkFile(file);
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
