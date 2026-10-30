import { Counterparty } from '../../models/Counterparty.js';
import { State } from '../../models/State.js';
import { AppError } from '../../shared/errors.js';
import { gstinMatchesStateCode, isValidGstin, panFromGstin } from '../../shared/validators.js';
import { env, isProduction } from '../../config/env.js';
const BUYER_KINDS = ['buyer', 'both'];
const validationDisabled = !isProduction && env.disableInputValidation;
const id = (value) => String(value);
function refuse(field, messageEn, existing) {
    return new AppError({
        code: 'VALIDATION_FAILED',
        messageEn,
        field,
        retryable: false,
        ...(existing
            ? {
                meta: {
                    existingCounterpartyId: id(existing._id),
                    existingFirm: existing.firm ?? '',
                    existingKind: existing.kind,
                },
            }
            : {}),
    });
}
const firmName = (cp) => cp.firm?.trim() || 'another firm';
export async function checkBuyerIdentity(input) {
    const gstin = input.gstin?.trim().toUpperCase() || undefined;
    const pan = (gstin ? panFromGstin(gstin) : input.pan?.trim().toUpperCase()) || null;
    // DEC-068 — staff may hold a buyer with neither (a lead); the buyer app may not.
    if (!pan && input.mode === 'self') {
        throw refuse('gstin', 'Enter the GSTIN — or the PAN, if he has no GSTIN.');
    }
    const notSelf = input.exceptCounterpartyId ? { _id: { $ne: input.exceptCounterpartyId } } : {};
    if (gstin) {
        if (!validationDisabled && !isValidGstin(gstin)) {
            throw refuse('gstin', 'That GSTIN does not check out.');
        }
        if (input.stateId) {
            const state = await State.findById(input.stateId);
            if (state && !gstinMatchesStateCode(gstin, state.gstStateCode)) {
                throw refuse('gstin', `This GSTIN starts with state code ${gstin.slice(0, 2)}, but the address is in ${state.name} (${state.gstStateCode}).`);
            }
        }
        const byGstin = await Counterparty.findOne({ gstin, deletedAt: null, ...notSelf });
        if (byGstin) {
            throw refuse('gstin', BUYER_KINDS.includes(byGstin.kind)
                ? `This GSTIN is already registered — ${firmName(byGstin)}.`
                : `This GSTIN is already on TriFid as a seller — ${firmName(byGstin)}. A firm that buys and sells is linked from the seller's side.`, byGstin);
        }
    }
    else if (pan) {
        const byPan = await Counterparty.findOne({
            pan,
            kind: { $in: BUYER_KINDS },
            $or: [{ gstin: null }, { gstin: { $exists: false } }],
            deletedAt: null,
            ...notSelf,
        });
        if (byPan) {
            throw refuse('pan', `A buyer without a GSTIN already has this PAN — ${firmName(byPan)}.`, byPan);
        }
    }
    const warnings = [];
    // The same holder, seen from the other side: a PAN-only buyer and a GSTIN
    // buyer whose GSTIN carries that PAN.
    const panTwin = !pan
        ? null
        : gstin
            ? await Counterparty.findOne({
                pan,
                kind: { $in: BUYER_KINDS },
                $or: [{ gstin: null }, { gstin: { $exists: false } }],
                deletedAt: null,
                ...notSelf,
            })
            : await Counterparty.findOne({
                gstin: { $regex: `^\\d{2}${pan}` },
                kind: { $in: BUYER_KINDS },
                deletedAt: null,
                ...notSelf,
            });
    if (panTwin && !input.confirmations?.panInsideGstin) {
        warnings.push({
            key: 'panInsideGstin',
            field: gstin ? 'gstin' : 'pan',
            message: gstin
                ? `${firmName(panTwin)} is already a buyer on this PAN without a GSTIN. Tick to confirm this is a separate firm.`
                : `This PAN is inside the GSTIN of ${firmName(panTwin)}. Tick to confirm this is a separate firm.`,
            existingFirm: firmName(panTwin),
            existingCounterpartyId: id(panTwin._id),
        });
    }
    const mobileField = input.mode === 'edit' ? 'contactMobile' : 'mobile';
    const byMobile = await Counterparty.findOne({
        $or: [{ mobile: input.mobile }, { contactMobile: input.mobile }],
        deletedAt: null,
        ...notSelf,
    });
    if (byMobile) {
        if (input.mode === 'self') {
            throw refuse('mobile', 'This mobile number already has an account — sign in with it instead.', byMobile);
        }
        if (!input.confirmations?.sharedMobile) {
            warnings.push({
                key: 'sharedMobile',
                field: mobileField,
                message: `${firmName(byMobile)} already uses this mobile. Tick to confirm the same person runs both firms.`,
                existingFirm: firmName(byMobile),
                existingCounterpartyId: id(byMobile._id),
            });
        }
    }
    if (warnings.length > 0) {
        throw new AppError({
            code: 'CONFIRMATION_REQUIRED',
            messageEn: warnings.map((w) => w.message).join(' '),
            field: warnings[0].field,
            retryable: false,
            meta: { warnings },
        });
    }
    // DEC-055 — the login stays unique: a number some firm already signs in
    // with is this firm's contact number only.
    const loginTaken = await Counterparty.exists({ mobile: input.mobile, ...notSelf });
    return {
        gstin,
        pan,
        loginMobile: loginTaken ? null : input.mobile,
        contactMobile: input.mobile,
    };
}
