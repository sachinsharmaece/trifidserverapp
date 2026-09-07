import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { withTransaction } from '../src/db/transaction.js';
import { Config } from '../src/models/Config.js';

describe('withTransaction', () => {
  it('rolls back every write when the callback throws', async () => {
    const key = `test:rollback:${Date.now()}`;

    await expect(
      withTransaction(async (session) => {
        await Config.create(
          [{ key, value: 1, version: 1, updatedBy: new mongoose.Types.ObjectId() }],
          { session },
        );
        throw new Error('forced failure');
      }),
    ).rejects.toThrow('forced failure');

    const found = await Config.findOne({ key });
    expect(found).toBeNull();
  });

  it('commits every write when the callback succeeds', async () => {
    const key = `test:commit:${Date.now()}`;

    await withTransaction(async (session) => {
      await Config.create(
        [{ key, value: 1, version: 1, updatedBy: new mongoose.Types.ObjectId() }],
        { session },
      );
    });

    const found = await Config.findOne({ key });
    expect(found).not.toBeNull();
  });
});
