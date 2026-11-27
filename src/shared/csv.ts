/**
 * CSV files for the registers (SRS-RPT-02, SRS-RPT-03). Plain rules, written once:
 *   - Excel needs a "byte order mark" at the start to read rupee signs and Hindi names correctly.
 *   - A cell with a comma, a quote or a line break is wrapped in quotes, and a quote inside becomes two (RFC 4180).
 *   - A text cell that starts with = + - @ could run as a formula when the file is opened in Excel, so it gets a
 *     leading ' (the "formula injection" guard). A plain number such as -100.00 is left alone.
 *   - Money is written as rupees with 2 decimals (123450 paise → 1234.50). Dates are YYYY-MM-DD, Indian time.
 */

const BOM = '\uFEFF';
const LOOKS_LIKE_A_FORMULA = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

export type CsvValue = string | number | null | undefined;

/** 123450 → "1234.50" (always 2 decimals, no thousands separator, so Excel treats it as a number). */
export function rupees(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const whole = Math.abs(paise);
  return `${sign}${Math.floor(whole / 100)}.${String(whole % 100).padStart(2, '0')}`;
}

/** One cell, made safe. */
export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && LOOKS_LIKE_A_FORMULA.test(text) && !PLAIN_NUMBER.test(text)) {
    text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The whole file: a header row, then one line per row, with the byte order mark in front. */
export function toCsv(headers: string[], rows: CsvValue[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(csvCell).join(','));
  return `${BOM}${lines.join('\r\n')}\r\n`;
}
