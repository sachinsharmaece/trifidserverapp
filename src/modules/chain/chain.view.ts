import { PERMISSIONS } from '../../config/permissions.js';

/**
 * M9 — the chain view, projected per audience (CH §17.3, CH §17.4, BR-060, BR-071).
 *
 * `GET /staff/chains/:id` used to hand the raw SO, PO and event documents to
 * every role holding `chain:read` — Purchase saw the buyer and the order value,
 * Sales saw the seller, Logistics saw both and all the money. The wall is
 * enforced by fields being ABSENT from the type each audience receives, so each
 * audience below gets its own small object, built field by field. There is no
 * "start from the full document and delete" step to forget.
 */
export type ChainViewAudience = 'full' | 'sales' | 'purchase' | 'logistics';

/**
 * Which projection a caller gets, decided from permissions (TD-007), never a
 * role name. Anyone whose permissions do not clearly point to exactly one desk
 * gets the narrowest view.
 */
export function chainViewAudienceFor(permissions: readonly string[]): ChainViewAudience {
  if (permissions.includes(PERMISSIONS.CHAIN_READ_FULL)) return 'full';
  const isSales = permissions.includes(PERMISSIONS.SO_CREATE);
  const isPurchase = permissions.includes(PERMISSIONS.PO_CREATE);
  if (isSales && !isPurchase) return 'sales';
  if (isPurchase && !isSales) return 'purchase';
  return 'logistics';
}

interface RawSo {
  _id: unknown;
  soNo: string;
  state: string;
  buyerId: unknown;
  totalPaise: number;
  payDeadline: Date;
}
interface RawPo {
  _id: unknown;
  poNo: string;
  state: string;
  sellerId: unknown;
  dispatchDueDate: Date;
}
interface RawEvent {
  type: string;
  at: Date;
}

export interface RawChainView {
  chainNo: string;
  stage: string;
  so: RawSo | null;
  po: RawPo | null;
  events: RawEvent[];
  // The full audience also receives everything else on the documents.
  raw: { so: unknown; po: unknown; events: unknown[] };
}

const eventsOf = (events: RawEvent[]): Array<{ type: string; at: Date }> =>
  events.map((event) => ({ type: event.type, at: event.at }));

export function projectChainView(audience: ChainViewAudience, view: RawChainView): unknown {
  const { chainNo, stage, so, po, events } = view;

  if (audience === 'full') {
    return { chainNo, stage, so: view.raw.so, po: view.raw.po, events: view.raw.events };
  }

  if (audience === 'sales') {
    // His side: the buyer and the buyer-facing value. No seller, no seller rate.
    return {
      chainNo,
      stage,
      so: so && {
        soId: String(so._id),
        soNo: so.soNo,
        state: so.state,
        buyerId: String(so.buyerId),
        totalPaise: so.totalPaise,
        payDeadline: so.payDeadline,
      },
      po: po && { poNo: po.poNo, state: po.state, dispatchDueDate: po.dispatchDueDate },
      events: eventsOf(events),
    };
  }

  if (audience === 'purchase') {
    // His side: the seller. No buyer, no buyer-side rupee value (CH §18.5).
    return {
      chainNo,
      stage,
      so: so && { soId: String(so._id), soNo: so.soNo, state: so.state },
      po: po && {
        poId: String(po._id),
        poNo: po.poNo,
        state: po.state,
        sellerId: String(po.sellerId),
        dispatchDueDate: po.dispatchDueDate,
      },
      events: eventsOf(events),
    };
  }

  // Logistics — no firm on either side and no money (CH §17.3.1, BR-071).
  return {
    chainNo,
    stage,
    so: so && { soNo: so.soNo, state: so.state },
    po: po && { poNo: po.poNo, state: po.state, dispatchDueDate: po.dispatchDueDate },
    events: eventsOf(events),
  };
}
