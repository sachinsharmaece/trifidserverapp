/**
 * How a posted payment has been spent (Build 9). A POSTED payment is spent on orders through `allocations`; what is
 * left is an advance on the buyer's account. Pure functions: no database here, so every module may use them.
 */

interface ReceiptLike {
  status: string;
  amountPaise: number;
  salesOrderId?: unknown;
  allocations?: readonly { amountPaise: number }[] | null;
}

/**
 * Σ spent on orders. A payment posted before Build 9 has no allocations list: it was entered against one order and
 * posted in full, so it counts as spent in full on that order.
 */
export function allocatedPaise(receipt: ReceiptLike): number {
  const listed = (receipt.allocations ?? []).reduce((sum, item) => sum + item.amountPaise, 0);
  if (listed > 0) return listed;
  return receipt.status === 'POSTED' && receipt.salesOrderId ? receipt.amountPaise : 0;
}

/** What is left of a POSTED payment: the buyer's advance. Anything not POSTED has no advance in it. */
export function unspentPaise(receipt: ReceiptLike): number {
  return receipt.status === 'POSTED' ? receipt.amountPaise - allocatedPaise(receipt) : 0;
}
