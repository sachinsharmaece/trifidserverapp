import { z } from 'zod';

export const disagreeSchema = z
  .object({
    reason: z.string().min(1),
  })
  .strict();

// BR-215 — fixed failure types, coded by the desk, never free text.
export const FAILURE_TYPES = [
  'seller_no_dispatch_48h',
  'seller_stock_nil_after_acceptance',
  'seller_whole_lot_rejection_fault',
  'seller_won_quote_could_not_supply',
  'buyer_missed_payment_window',
  'buyer_refused_goods_at_delivery',
] as const;

export const recordFailureSchema = z
  .object({
    counterpartyId: z.string().min(1),
    counterpartyKind: z.enum(['buyer', 'seller']),
    type: z.enum(FAILURE_TYPES),
    chainId: z.string().optional(),
    viaFraud: z.boolean().optional(),
  })
  .strict();

export const advanceConductStageSchema = z
  .object({
    toStage: z.enum(['cure_period', 'strike', 'appeal', 'revision', 'waive']),
    reason: z.string().min(1),
    checkerEmployeeId: z.string().min(1),
  })
  .strict();
