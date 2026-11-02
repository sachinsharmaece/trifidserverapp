/**
 * The exact expiry as it is stored and shown (BR-102): a month and year, `03/2027`, or the year alone,
 * `2027`, when the month is not known. The year is always there; the month is optional.
 */
export const EXPIRY_EXACT_PATTERN = /^((0[1-9]|1[0-2])\/)?\d{4}$/;

export const EXPIRY_EXACT_MESSAGE =
  'Give the expiry as a year (2027) or a month and year (03/2027).';
