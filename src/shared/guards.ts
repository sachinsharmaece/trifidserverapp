import type { Types } from 'mongoose';
import { Counterparty } from '../models/Counterparty.js';
import { AppError } from './errors.js';

/**
 * BR-213/QR-015 — three strikes blacklists a counterparty, but only blocks
 * *new* activity; nothing in flight is touched (chains, payouts and refunds
 * already running continue under ordinary rules). Call this at every entry
 * point that starts something new: a listing, a quote, an inquiry, a pool
 * join. Never call it on a read, and never call it inside a flow that is
 * continuing an already-existing commitment (payment, dispatch, inspection).
 */
export async function assertCounterpartyActive(
  counterpartyId: Types.ObjectId | string,
): Promise<void> {
  const counterparty = await Counterparty.findById(counterpartyId);
  if (counterparty?.status === 'blacklisted') {
    throw new AppError({
      code: 'ACCOUNT_NOT_ACTIVE',
      messageEn: 'This account is blocked. Call the sales desk for help.',
    });
  }
}
