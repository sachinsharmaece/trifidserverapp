/**
 * TD-008 — the wall is enforced by audience-typed projections. There is no
 * shared `User` type. BuyerMeDto, SellerMeDto and StaffMeDto are three
 * separate TypeScript types, and none of the counterparty types has a field
 * capable of holding a staff role or a permission list.
 *
 * RECOMMENDATION — NOT A CLIENT DECISION: the SSOT does not yet specify what
 * a `kind: 'both'` firm's own /me response looks like (buyer-only and
 * seller-only fields do not exist until M3). Until then a `both` firm gets
 * its own BothMeDto — still no staff field anywhere on it — rather than
 * arbitrarily picking buyer or seller.
 */
export {};
