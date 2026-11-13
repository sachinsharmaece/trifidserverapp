import { Config } from '../src/models/Config.js';
import { Types } from 'mongoose';

/**
 * RECTIFY-01 Phase 0 — requote is refused unless `config.pile_requote_enabled` is on, and it ships
 * off. A test that exercises the requote mechanism itself turns the flag on for the length of `work`
 * and puts it back, so nothing else in the file sees it.
 */
export async function withPileRequoteEnabled<T>(work: () => Promise<T>): Promise<T> {
  const set = (value: boolean) =>
    Config.updateOne(
      { key: 'pile_requote_enabled' },
      { $set: { value, version: 1, updatedBy: new Types.ObjectId() } },
      { upsert: true },
    );
  await set(true);
  try {
    return await work();
  } finally {
    await set(false);
  }
}
