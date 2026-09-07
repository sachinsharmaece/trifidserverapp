import { maskAccountNumber, decryptAccountNumber } from '../../shared/encryption.js';
import type { BankDetailDocument } from '../../models/BankDetail.js';
import type { HydratedDocument } from 'mongoose';

/**
 * ARCHITECTURE.md §8 — bank details masked in every UI. Written once here
 * so no future response can forget to mask it (the same reasoning as
 * TD-008's audience DTOs).
 */
export interface BankDetailDto {
  bankDetailId: string;
  maskedAccountNumber: string;
  ifsc: string;
  accountName: string;
  isActive: boolean;
  verifiedAt: Date | null;
  effectiveFrom: Date | null;
}

export function toBankDetailDto(detail: HydratedDocument<BankDetailDocument>): BankDetailDto {
  return {
    bankDetailId: detail.id as string,
    maskedAccountNumber: maskAccountNumber(decryptAccountNumber(detail.accountEncrypted)),
    ifsc: detail.ifsc,
    accountName: detail.accountName,
    isActive: detail.isActive,
    verifiedAt: detail.verifiedAt ?? null,
    effectiveFrom: detail.effectiveFrom ?? null,
  };
}
