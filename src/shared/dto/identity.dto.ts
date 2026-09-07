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

export type CounterpartyStatus = 'pending' | 'active' | 'rejected' | 'blacklisted';

export interface BuyerMeDto {
  actorType: 'counterparty';
  counterpartyId: string;
  mobile: string;
  kind: 'buyer';
  status: CounterpartyStatus;
}

export interface SellerMeDto {
  actorType: 'counterparty';
  counterpartyId: string;
  mobile: string;
  kind: 'seller';
  status: CounterpartyStatus;
}

export interface BothMeDto {
  actorType: 'counterparty';
  counterpartyId: string;
  mobile: string;
  kind: 'both';
  status: CounterpartyStatus;
}

export interface StaffMeDto {
  actorType: 'staff';
  employeeId: string;
  email: string;
  person: string;
  roles: string[];
  permissions: string[];
  mfaEnabled: boolean;
}

export type MeResponse = BuyerMeDto | SellerMeDto | BothMeDto | StaffMeDto;

/**
 * The build-failing half of the wall sweep (CH §25.6, TD-008). If a future
 * edit adds `roles` or `permissions` to any counterparty DTO, `AssertFalse`
 * below stops satisfying its `extends false` constraint and `tsc --noEmit`
 * (part of `npm test`'s prerequisite chain) fails on this file — before any
 * such field could reach a response. See tests/wallSweep.test.ts for the
 * matching runtime check.
 */
type HasStaffField<T> = T extends { roles: unknown } | { permissions: unknown } ? true : false;
type AssertFalse<T extends false> = T;
export type WallSweepBuyer = AssertFalse<HasStaffField<BuyerMeDto>>;
export type WallSweepSeller = AssertFalse<HasStaffField<SellerMeDto>>;
export type WallSweepBoth = AssertFalse<HasStaffField<BothMeDto>>;
