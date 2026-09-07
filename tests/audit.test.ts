import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { writeAuditLog } from '../src/shared/audit.js';
import { AuditLog } from '../src/models/AuditLog.js';

describe('audit_log', () => {
  it('writes an entry that can be read back', async () => {
    const entityId = new mongoose.Types.ObjectId();
    await writeAuditLog({
      actorId: new mongoose.Types.ObjectId(),
      actorType: 'system',
      entity: 'test_entity',
      entityId,
      field: 'value',
      oldValue: 1,
      newValue: 2,
      correlationId: 'test-correlation',
    });

    const found = await AuditLog.findOne({ entityId });
    expect(found).not.toBeNull();
    expect(found?.newValue).toBe(2);
  });

  it('cannot be updated once written (CH §17.6 append-only)', async () => {
    const entry = await AuditLog.create({
      actorId: new mongoose.Types.ObjectId(),
      actorType: 'system',
      entity: 'test_entity',
      entityId: new mongoose.Types.ObjectId(),
      correlationId: 'test-correlation',
    });

    await expect(
      AuditLog.updateOne({ _id: entry._id }, { $set: { field: 'changed' } }),
    ).rejects.toThrow(/append-only/);
  });

  it('cannot be deleted once written', async () => {
    const entry = await AuditLog.create({
      actorId: new mongoose.Types.ObjectId(),
      actorType: 'system',
      entity: 'test_entity',
      entityId: new mongoose.Types.ObjectId(),
      correlationId: 'test-correlation',
    });

    await expect(AuditLog.deleteOne({ _id: entry._id })).rejects.toThrow(/append-only/);
  });
});
