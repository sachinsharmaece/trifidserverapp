import { z } from 'zod';

export const createUpcomingReceiptSchema = z
  .object({
    amountPaise: z.number().int().positive(),
    method: z.enum(['bank_message', 'utr', 'screenshot']),
    rawText: z.string().optional(),
    utr: z.string().optional(),
    fileId: z.string().optional(),
  })
  .strict();

export const allocateUpcomingReceiptSchema = z
  .object({
    soIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const postBankCreditSchema = z
  .object({
    utr: z.string().min(1),
    remitterAccountNumber: z.string().min(4).max(34),
    remitterIfsc: z.string().length(11),
  })
  .strict();

export const repostBankEntrySchema = z
  .object({
    reason: z.string().min(1),
    corrected: z
      .object({
        kind: z.enum(['in', 'out']),
        purpose: z.enum(['receipt', 'payout', 'refund']),
        partyId: z.string().min(1),
        partyType: z.enum(['buyer', 'seller']),
        amountPaise: z.number().int().positive(),
        utr: z.string().optional(),
        narration: z.string().optional(),
      })
      .strict(),
  })
  .strict();

export const buildPaymentRunSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            kind: z.enum(['payout', 'refund']),
            refId: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const releasePaymentRunSchema = z
  .object({
    utrs: z.array(z.string()).optional(),
  })
  .strict();

export const dayCloseSchema = z
  .object({
    statementClosingPaise: z.number().int(),
  })
  .strict();
