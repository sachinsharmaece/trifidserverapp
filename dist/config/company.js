const DEFAULT_PROFILE = {
    name: 'TriFid Stores Pvt. Ltd.',
    addressLines: ['Runija Road, Barnagar'],
    gstin: '23AAHCT4156E1ZJ',
};
/** `COMPANY_NAME`, `COMPANY_ADDRESS` (lines separated by `|`) and `COMPANY_GSTIN` override the defaults. */
export function getCompanyProfile() {
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
export const PO_TERMS = [];
