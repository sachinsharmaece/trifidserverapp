export function randomMobile(): string {
  const rest = Math.floor(100000000 + Math.random() * 899999999)
    .toString()
    .padStart(9, '0');
  return `9${rest}`;
}

export function randomEmail(): string {
  return `test-${Date.now()}-${Math.floor(Math.random() * 100000)}@trifid.example`;
}

const GSTIN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function randomLetters(length: number): string {
  let result = '';
  for (let i = 0; i < length; i += 1) {
    result += GSTIN_ALPHABET[Math.floor(Math.random() * GSTIN_ALPHABET.length)];
  }
  return result;
}

function randomDigits(length: number): string {
  let result = '';
  for (let i = 0; i < length; i += 1) {
    result += Math.floor(Math.random() * 10).toString();
  }
  return result;
}

// A checksum-valid, format-valid GSTIN with random (fictional) parts —
// enough to exercise real validation logic in a test without needing a
// real firm's real GSTIN.
export async function randomGstin(): Promise<string> {
  const { computeGstinChecksum } = await import('../src/shared/validators.js');
  const first14 = `${randomDigits(2)}${randomLetters(5)}${randomDigits(4)}${randomLetters(1)}1Z`;
  return `${first14}${computeGstinChecksum(first14)}`;
}
