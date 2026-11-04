/**
 * Who TriFid is on a document it issues (the purchase order's header). Read when the document is
 * built, so a value set in the environment takes effect without a rebuild; the defaults are the
 * company's own details as the client gave them on 3 Nov 2026.
 *
 * Bank details are deliberately not here: a purchase order goes to a seller, who is paid by TriFid
 * and has no use for TriFid's account. The terms text has not been supplied yet, so the purchase
 * order carries no terms section until it is.
 */
export interface CompanyProfile {
  name: string;
  /** One printed line each. */
  addressLines: string[];
  gstin: string;
}

const DEFAULT_PROFILE: CompanyProfile = {
  name: 'TriFid Stores Pvt. Ltd.',
  addressLines: ['Runija Road, Barnagar'],
  gstin: '23AAHCT4156E1ZJ',
};

/** `COMPANY_NAME`, `COMPANY_ADDRESS` (lines separated by `|`) and `COMPANY_GSTIN` override the defaults. */
export function getCompanyProfile(): CompanyProfile {
  const address = process.env.COMPANY_ADDRESS?.split('|')
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    name: process.env.COMPANY_NAME?.trim() || DEFAULT_PROFILE.name,
    addressLines: address?.length ? address : DEFAULT_PROFILE.addressLines,
    gstin: process.env.COMPANY_GSTIN?.trim().toUpperCase() || DEFAULT_PROFILE.gstin,
  };
}

/** The terms printed on a purchase order. Empty until the client supplies the text. */
export const PO_TERMS: readonly string[] = [];
