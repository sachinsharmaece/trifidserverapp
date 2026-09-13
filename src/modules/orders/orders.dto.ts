import type { Types } from 'mongoose';
import type { SoDocument, SoState } from '../../models/So.js';
import type { PoDocument, PoState } from '../../models/Po.js';
import type { MovementDocument } from '../../models/Movement.js';
import type { Paise } from '../../shared/money.js';

/**
 * API-070 — "two different response types." `BuyerSoDto` never carries a
 * sellerId or a seller net rate (BR-060); `SellerPoDto` never carries a
 * buyerId or a delivery location, and its movement summary is blind on the
 * terminal leg-2 step (BR-138 — "the last step is blind... carries no
 * destination"). Both DTOs are built here, in the one place, rather than
 * inline in the service, so the wall is one function to review, not N.
 */

// The ladder rung a screen renders — coarser than SO_STATES/PO_STATES,
// finer than chain.stage. Includes the Round-2 correction: "Paperwork at
// Indore" (BR-030's stage-4 leg, covering at_indore/inspected/billed_in_marg)
// as its own rung rather than folding it into "Leg 1" or "Leg 2".
export const ORDER_RUNGS = [
  'placed',
  'payment',
  'seller_confirmed',
  'leg1_dispatch',
  'paperwork_at_indore',
  'leg2_dispatch',
  'delivered',
  'closed',
  'stopped',
] as const;
export type OrderRung = (typeof ORDER_RUNGS)[number];

const SO_STATE_TO_RUNG: Record<SoState, OrderRung> = {
  draft: 'placed',
  awaiting_seller_confirmation: 'placed',
  requote_offered: 'placed',
  awaiting_payment: 'payment',
  payment_verifying: 'payment',
  po_released: 'seller_confirmed',
  dispatched_leg1: 'leg1_dispatch',
  at_indore: 'paperwork_at_indore',
  inspected: 'paperwork_at_indore',
  billed_in_marg: 'paperwork_at_indore',
  dispatched_leg2: 'leg2_dispatch',
  delivered: 'delivered',
  closed: 'closed',
  cancelled: 'stopped',
  supply_failed: 'stopped',
  disputed: 'stopped',
};

export function rungForSoState(state: SoState): OrderRung {
  return SO_STATE_TO_RUNG[state];
}

export interface BuyerSoDto {
  soId: string;
  soNo: string;
  rung: OrderRung;
  soState: SoState;
  totalPaise: Paise;
  payDeadline: Date;
  deliveryWindowEndsAt: Date | null;
  createdAt: Date;
  // BR-138 — the buyer is not the one this rule is about, so his own leg-1
  // dispatch info is shown in full; nothing here is a wall concern.
  leg1?: { mode: string; dispatchedAt: Date } | null;
  canConfirmReceipt: boolean;
  canComplain: boolean;
  canPay: boolean;
}

export function toBuyerSoDto(
  so: SoDocument & { _id: Types.ObjectId },
  leg1: MovementDocument | null,
): BuyerSoDto {
  return {
    soId: (so._id as Types.ObjectId).toString(),
    soNo: so.soNo,
    rung: rungForSoState(so.state as SoState),
    soState: so.state as SoState,
    totalPaise: so.totalPaise,
    payDeadline: so.payDeadline,
    deliveryWindowEndsAt: so.deliveryWindowEndsAt ?? null,
    createdAt: (so as unknown as { createdAt: Date }).createdAt,
    leg1: leg1 ? { mode: leg1.mode, dispatchedAt: leg1.dispatchedAt } : null,
    canConfirmReceipt: so.state === 'dispatched_leg2',
    canComplain: so.state === 'dispatched_leg2' || so.state === 'delivered',
    canPay: so.state === 'awaiting_payment',
  };
}

export interface SellerPoDto {
  poId: string;
  poNo: string;
  rung: OrderRung;
  poState: PoState;
  dispatchDueDate: Date;
  promisedOutOfIndoreBy: Date;
  hold: boolean;
  failed: boolean;
  requoteCount: number;
  extensionRequestedAt: Date | null;
  // BR-138 — his own leg-1 (he performed it) is shown; leg-2 is reduced to a
  // bare boolean with no date, no destination — "the consignment left
  // Indore" and nothing else.
  leg1?: { mode: string; dispatchedAt: Date } | null;
  leg2Dispatched: boolean;
  canDispatchLeg1: boolean;
  canRequestExtension: boolean;
}

export function toSellerPoDto(
  po: PoDocument & { _id: Types.ObjectId },
  soState: SoState,
  leg1: MovementDocument | null,
  leg2Exists: boolean,
): SellerPoDto {
  return {
    poId: (po._id as Types.ObjectId).toString(),
    poNo: po.poNo,
    rung: rungForSoState(soState),
    poState: po.state as PoState,
    dispatchDueDate: po.dispatchDueDate,
    promisedOutOfIndoreBy: po.promisedOutOfIndoreBy,
    hold: po.hold,
    failed: po.failed,
    requoteCount: po.requoteCount,
    extensionRequestedAt: po.extensionRequestedAt ?? null,
    leg1: leg1 ? { mode: leg1.mode, dispatchedAt: leg1.dispatchedAt } : null,
    leg2Dispatched: leg2Exists,
    canDispatchLeg1: po.state === 'released',
    canRequestExtension: po.state === 'released' && !po.extensionRequestedAt,
  };
}
