import { Router } from 'express';
import { z } from 'zod';
import { CompanyModel } from '../../models/index.js';
import { onlyChanged, writeAudit } from '../../shared/audit.js';
import { encryptText } from '../../shared/encryption.js';
import { failIfDuplicate } from '../../shared/mongo.js';
import { IFSC_PATTERN, isValidGstin } from '../../shared/validators.js';
import { currentUserOf, requireAuth } from '../auth/requireAuth.js';
import { nameField } from './fields.js';
import { canEditMasters } from './permissions.js';
export const companyRouter = Router();
/** An empty text means "nothing here" for the optional bank fields. */
const optional = (valid, message) => z
    .string()
    .trim()
    .refine((text) => text === '' || valid(text), message);
const saveBody = z.object({
    name: nameField('the company name', 200),
    gstin: z
        .string()
        .trim()
        .toUpperCase()
        .refine(isValidGstin, 'This is not a valid GSTIN. Check the letters, digits and last character.'),
    address: z.string().trim().min(1, 'Enter the address.').max(500),
    bank: z.object({
        // Empty or left out = keep the number already saved. The number is never sent back to the browser.
        accountNumber: optional((text) => /^\d{9,18}$/.test(text), 'An account number has 9 to 18 digits.').optional(),
        ifsc: optional((text) => IFSC_PATTERN.test(text.toUpperCase()), 'An IFSC code is 4 letters, a zero, then 6 letters or digits.'),
        bankName: z.string().trim().max(100),
    }),
});
/** What the browser gets. The bank account number (and its locked copy) never leaves the server: only the last 4 digits. */
function toCompany(company) {
    return {
        id: company.id,
        name: company.name ?? '',
        gstin: company.gstin ?? '',
        stateCode: company.stateCode ?? '',
        address: company.address ?? '',
        bank: {
            accountLast4: company.bank?.accountLast4 ?? null,
            ifsc: company.bank?.ifsc ?? '',
            bankName: company.bank?.bankName ?? '',
        },
        updatedAt: company.updatedAt?.toISOString() ?? null,
    };
}
/** The fields that go in the audit log. Never the full account number. */
function auditFields(company) {
    return {
        name: company.name ?? '',
        gstin: company.gstin ?? '',
        address: company.address ?? '',
        ifsc: company.bank?.ifsc ?? '',
        bankName: company.bank?.bankName ?? '',
        accountLast4: company.bank?.accountLast4 ?? '',
    };
}
companyRouter.use('/company', requireAuth);
/** GET /company  ->  { company }, or { company: null } before it has been set up. */
companyRouter.get('/company', async (_req, res) => {
    const company = await CompanyModel.findOne();
    res.json({ company: company ? toCompany(company) : null });
});
/**
 * PUT /company  { name, gstin, address, bank: { accountNumber?, ifsc, bankName } }  ->  { company }.
 * There is exactly one company record: the first PUT creates it, later ones change it.
 * The account number is locked (AES-256-GCM) before saving; only its last 4 digits are kept readable.
 */
companyRouter.put('/company', canEditMasters, async (req, res) => {
    const body = saveBody.parse(req.body);
    const company = (await CompanyModel.findOne()) ?? new CompanyModel();
    const before = auditFields(company);
    company.set({
        name: body.name,
        gstin: body.gstin, // the state code is filled in from the GSTIN when saving
        address: body.address,
        updatedBy: currentUserOf(req).id,
    });
    company.set('bank.ifsc', body.bank.ifsc ? body.bank.ifsc.toUpperCase() : undefined);
    company.set('bank.bankName', body.bank.bankName || undefined);
    const newNumber = body.bank.accountNumber;
    if (newNumber) {
        company.set('bank.accountNumberEnc', encryptText(newNumber)); // fails here, before anything is saved, if no key is set
        company.set('bank.accountLast4', newNumber.slice(-4));
    }
    const isNew = company.isNew;
    await company
        .save()
        .catch(failIfDuplicate('The company profile already exists. Reload and try again.', 'COMPANY_EXISTS'));
    const diff = onlyChanged(before, auditFields(company));
    if (newNumber) {
        // Replacing a number can leave the last 4 digits the same, so say so explicitly (never log the number).
        diff.before['accountNumber'] = before.accountLast4 ? 'on file' : 'none';
        diff.after['accountNumber'] = 'replaced';
    }
    if (Object.keys(diff.after).length > 0) {
        await writeAudit(req, {
            action: isNew ? 'company.create' : 'company.update',
            entityType: 'Company',
            entityId: company.id,
            ...diff,
        });
    }
    res.json({ company: toCompany(company) });
});
//# sourceMappingURL=company.routes.js.map