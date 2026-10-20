import { z } from 'zod';
import { SUPPLY_GAP_CODES } from '../../../models/NonOrderReason.js';
import { isValidHsn, packLabelMatchesBaseUnit } from '../../../shared/validators.js';

export const nonOrderReasonSchema = z
  .object({
    askId: z.string().optional(),
    pileId: z.string().optional(),
    code: z.enum(SUPPLY_GAP_CODES),
  })
  .strict()
  .refine((v) => !!v.askId || !!v.pileId, {
    message: 'Either askId or pileId is required.',
  });

// ---------------------------------------------------------------------------
// Purchase-desk v2.
// ---------------------------------------------------------------------------

// Stock → PO → Billed → Dispatch stage actions. Each records what the seller said on a call, so
// each carries the call note (like every other staff-assisted action).
const stageCallNote = z.string().trim().min(1);

export const requestStockHoldSchema = z
  .object({
    // Default 24 hours (the buyer's payment window); a seller may agree to more or less.
    holdHours: z.number().int().min(1).max(72).optional(),
    callNote: stageCallNote,
  })
  .strict();

export const adjustStockHoldSchema = z
  .object({
    holdHours: z.number().int().min(1).max(72),
    callNote: stageCallNote,
  })
  .strict();

export const stageCallNoteSchema = z.object({ callNote: stageCallNote }).strict();

export const sellerInvoiceSchema = z
  .object({
    invoiceNo: z.string().trim().min(1).max(40),
    date: z.coerce.date(),
    ewayNo: z.string().trim().min(1).max(40),
    callNote: stageCallNote,
  })
  .strict();

// "Seller dispatched" — leg 1, the same details Logistics records (BR-176): LR on transport mode,
// bus number + driver + mobile on bus mode. Freight defaults to nothing owed.
export const sellerDispatchedSchema = z
  .object({
    mode: z.enum(['transport', 'bus']),
    transporter: z.string().trim().min(1).optional(),
    lr: z.string().trim().min(1).optional(),
    busNo: z.string().trim().min(1).optional(),
    driver: z.string().trim().min(1).optional(),
    driverMobile: z.string().trim().min(1).optional(),
    freightTerms: z.enum(['prepaid', 'to_pay']),
    freightAmountPaise: z.number().int().min(0).default(0),
    callNote: stageCallNote,
  })
  .strict()
  .refine((value) => value.mode !== 'transport' || !!value.lr, {
    message: 'LR number is mandatory on transport mode (BR-176).',
    path: ['lr'],
  })
  .refine(
    (value) => value.mode !== 'bus' || (!!value.busNo && !!value.driver && !!value.driverMobile),
    {
      message: 'Bus number, driver name and driver mobile are required on bus mode (BR-176).',
      path: ['busNo'],
    },
  );

export const askChaseSchema = z
  .object({
    sellerId: z.string().min(1),
  })
  .strict();

export const sellerCatalogueEntrySchema = z
  .object({
    sellerId: z.string().min(1),
    productId: z.string().min(1),
    skuIds: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const draftManufacturerSchema = z
  .object({
    name: z.string().min(1),
    aka: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const draftProductSchema = z
  .object({
    brand: z.string().min(1),
    technical: z.string().min(1),
    manufacturerId: z.string().min(1),
    hsn: z.string().min(1).refine(isValidHsn, { message: 'HSN must be 6 or 8 digits.' }),
    class: z.enum(['High', 'Medium', 'Low']).optional(),
  })
  .strict();

export const draftSkuSchema = z
  .object({
    productId: z.string().min(1),
    packLabel: z.string().min(1),
    packSize: z.number().positive({ message: 'Pack size must be a positive number.' }),
    baseUnit: z.enum(['LTR', 'KG', 'PC']),
    unitsPerBox: z.number().int().positive({ message: 'Units per box must be a positive number.' }),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!packLabelMatchesBaseUnit(v.packLabel, v.baseUnit)) {
      ctx.addIssue({
        code: 'custom',
        path: ['packLabel'],
        message: `The pack "${v.packLabel}" does not look like a ${v.baseUnit} pack.`,
      });
    }
  });
