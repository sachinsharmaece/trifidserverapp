/**
 * LOCK-34 §12.1 — the Marg party master was loaded with two stand-ins:
 *
 * - tehsil `zzzzz`: a party outside MP, or one with no known tehsil (state and
 *   district are real);
 * - a mobile from 9999999991 upward: a party with no known mobile.
 *
 * These are read and handled, never rewritten. Everything that matches,
 * counts or displays a tehsil or a mobile asks here first.
 */
const PLACEHOLDER_TEHSIL = 'zzzzz';
const FIRST_PLACEHOLDER_MOBILE = 9999999991;
export function isPlaceholderTehsil(tehsil) {
    return Boolean(tehsil) && tehsil.trim().toLowerCase() === PLACEHOLDER_TEHSIL;
}
export function isPlaceholderMobile(mobile) {
    if (!mobile)
        return false;
    const digits = mobile.trim();
    return /^\d{10}$/.test(digits) && Number(digits) >= FIRST_PLACEHOLDER_MOBILE;
}
