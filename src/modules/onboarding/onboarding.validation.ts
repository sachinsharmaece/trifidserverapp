import { z } from 'zod';

const mobileSchema = z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number.');
const gstinSchema = z.string().length(15, 'GSTIN must be 15 characters.');
const ifscSchema = z.string().length(11, 'IFSC must be 11 characters.');

const bankDetailInputSchema = z
  .object({
    accountNumber: z.string().min(4).max(34),
    ifsc: ifscSchema,
    accountName: z.string().min(1),
  })
  .strict();

const consentInputSchema = z
  .object({
    noticeVersion: z.string().min(1),
    marketingOptIn: z.boolean(),
  })
  .strict();

export const registerBuyerSchema = z
  .object({
    mobile: mobileSchema,
    firm: z.string().min(1),
    gstin: gstinSchema,
    ownerName: z.string().min(1),
    licenceNo: z.string().min(1),
    gstPpobAddress: z.string().min(1),
    dealerships: z
      .array(
        z.object({ manufacturerId: z.string().min(1), isStrong: z.boolean().optional() }).strict(),
      )
      .optional(),
    bankDetail: bankDetailInputSchema,
    consent: consentInputSchema,
  })
  .strict();

export const registerSellerSchema = z
  .object({
    mobile: mobileSchema,
    firm: z.string().min(1),
    gstin: gstinSchema,
    ownerName: z.string().min(1),
    licenceNo: z.string().min(1),
    // BR-250 — two or more named referees.
    references: z
      .array(
        z
          .object({
            firm: z.string().min(1),
            phone: z.string().min(1),
            relationship: z.string().min(1),
            whatTheySaid: z.string().min(1),
          })
          .strict(),
      )
      .min(2),
    bankDetail: bankDetailInputSchema,
    consent: consentInputSchema,
  })
  .strict();

export const listRegistrationsQuerySchema = z
  .object({
    stage: z.enum(['pending', 'active', 'rejected']).optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export const approveBuyerSchema = z
  .object({
    tehsilId: z.string().min(1),
    tradePosition: z.enum(['distributor', 'dealer', 'retailer']),
    isTrader: z.boolean(),
  })
  .strict();

export const approveSellerSchema = z
  .object({
    tehsilIds: z.array(z.string().min(1)).min(1),
    dispatchCutoffTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    trustTier: z.enum(['New', 'Verified', 'Trusted', 'Committed']).optional(),
    seedReason: z.string().optional(),
  })
  .strict();

export const rejectRegistrationSchema = z
  .object({
    reason: z.string().min(1),
  })
  .strict();

export const bankDetailChangeSchema = bankDetailInputSchema;
