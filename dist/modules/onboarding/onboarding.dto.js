import { maskAccountNumber, decryptAccountNumber } from '../../shared/encryption.js';
export function toBankDetailDto(detail) {
    return {
        bankDetailId: detail.id,
        maskedAccountNumber: maskAccountNumber(decryptAccountNumber(detail.accountEncrypted)),
        ifsc: detail.ifsc,
        accountName: detail.accountName,
        isActive: detail.isActive,
        verifiedAt: detail.verifiedAt ?? null,
        effectiveFrom: detail.effectiveFrom ?? null,
    };
}
