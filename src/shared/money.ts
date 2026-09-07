/**
 * Money helpers. DATA_MODEL.md §2.3 — every monetary value is an integer number
 * of paise. Never a Double, never a float, never a string. These helpers are the
 * only place allowed to convert between paise and rupees.
 */

export type Paise = number;

function assertInteger(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${label} must be an integer number of paise, got ${value}`);
  }
}

export function toPaise(value: Paise): Paise {
  assertInteger(value, 'toPaise');
  return value;
}

export function addPaise(a: Paise, b: Paise): Paise {
  assertInteger(a, 'addPaise(a)');
  assertInteger(b, 'addPaise(b)');
  return a + b;
}

export function subtractPaise(a: Paise, b: Paise): Paise {
  assertInteger(a, 'subtractPaise(a)');
  assertInteger(b, 'subtractPaise(b)');
  return a - b;
}

export function sumPaise(values: Paise[]): Paise {
  return values.reduce((total, value) => addPaise(total, value), 0);
}

// Rounds to the nearest paise. Only ever called on an intermediate calculation
// (e.g. a percentage of a paise value) — never on a value already stored as paise.
export function roundToPaise(value: number): Paise {
  return Math.round(value);
}

// For display only. Never feed the result back into storage or a calculation.
export function formatRupees(paise: Paise): string {
  assertInteger(paise, 'formatRupees');
  const rupees = paise / 100;
  return rupees.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Rupees entered by a human (e.g. an admin form) into the paise value that is stored.
export function rupeesToPaise(rupees: number): Paise {
  return Math.round(rupees * 100);
}
