export function randomMobile(): string {
  const rest = Math.floor(100000000 + Math.random() * 899999999)
    .toString()
    .padStart(9, '0');
  return `9${rest}`;
}

export function randomEmail(): string {
  return `test-${Date.now()}-${Math.floor(Math.random() * 100000)}@trifid.example`;
}
