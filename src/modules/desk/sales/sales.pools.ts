import type { Types } from 'mongoose';
import { Pool } from '../../../models/Pool.js';
import { PoolCommitment } from '../../../models/PoolCommitment.js';
import { Buyer } from '../../../models/Buyer.js';
import { Counterparty } from '../../../models/Counterparty.js';
import { BookAssignment } from '../../../models/BookAssignment.js';
import { Employee } from '../../../models/Employee.js';
import { AppError } from '../../../shared/errors.js';

export interface PoolCommitmentRow {
  poolCommitmentId: string;
  buyerId: string;
  buyerFirm: string;
  ownerName: string | null;
  qty: number;
  isBinding: boolean;
  reconfirmedAt: string | null;
  paidAt: string | null;
  withdrawnAt: string | null;
}

export interface PoolRow {
  poolId: string;
  skuId: string;
  conditionSetKey: string;
  moq: number;
  status: string;
  isActive: boolean;
  triggeredAt: string | null;
  payDeadline: string | null;
  committedQty: number;
  bindingQty: number;
  commitments: PoolCommitmentRow[];
}

async function toPoolRow(pool: InstanceType<typeof Pool>): Promise<PoolRow> {
  const commitments = await PoolCommitment.find({ poolId: pool._id }).sort({ createdAt: 1 });
  const buyerIds = commitments.map((c) => c.buyerId);
  const buyers = await Buyer.find({ _id: { $in: buyerIds } });
  const buyerById = new Map(buyers.map((b) => [(b._id as Types.ObjectId).toString(), b]));
  const counterparties = await Counterparty.find({ _id: { $in: buyers.map((b) => b.counterpartyId) } });
  const firmByCounterpartyId = new Map(
    counterparties.map((c) => [(c._id as Types.ObjectId).toString(), c.firm ?? '']),
  );
  const assignments = await BookAssignment.find({ buyerId: { $in: buyerIds } });
  const ownerEmployeeIdByBuyer = new Map(
    assignments.map((a) => [(a.buyerId as Types.ObjectId).toString(), a.ownerEmployeeId]),
  );
  const employees = await Employee.find({ _id: { $in: [...ownerEmployeeIdByBuyer.values()] } });
  const employeeNameById = new Map(employees.map((e) => [(e._id as Types.ObjectId).toString(), e.person]));

  const commitmentRows: PoolCommitmentRow[] = commitments.map((c) => {
    const buyerIdStr = (c.buyerId as Types.ObjectId).toString();
    const buyer = buyerById.get(buyerIdStr);
    const firm = buyer
      ? (firmByCounterpartyId.get((buyer.counterpartyId as Types.ObjectId).toString()) ?? '')
      : '';
    const ownerEmployeeId = ownerEmployeeIdByBuyer.get(buyerIdStr);
    return {
      poolCommitmentId: (c._id as Types.ObjectId).toString(),
      buyerId: buyerIdStr,
      buyerFirm: firm,
      ownerName: ownerEmployeeId ? (employeeNameById.get(ownerEmployeeId.toString()) ?? null) : null,
      qty: c.qty,
      isBinding: c.isBinding,
      reconfirmedAt: c.reconfirmedAt ? c.reconfirmedAt.toISOString() : null,
      paidAt: c.paidAt ? c.paidAt.toISOString() : null,
      withdrawnAt: c.withdrawnAt ? c.withdrawnAt.toISOString() : null,
    };
  });

  // A withdrawn commitment stays visible on the pool (so the desk can see who
  // dropped out) but no longer counts towards how close the pool is to MOQ.
  const live = commitmentRows.filter((c) => !c.withdrawnAt);
  const committedQty = live.reduce((sum, c) => sum + c.qty, 0);
  const bindingQty = live.filter((c) => c.isBinding).reduce((sum, c) => sum + c.qty, 0);

  return {
    poolId: (pool._id as Types.ObjectId).toString(),
    skuId: (pool.skuId as Types.ObjectId).toString(),
    conditionSetKey: pool.conditionSetKey,
    moq: pool.moq,
    status: pool.status,
    isActive: pool.isActive,
    triggeredAt: pool.triggeredAt ? pool.triggeredAt.toISOString() : null,
    payDeadline: pool.payDeadline ? pool.payDeadline.toISOString() : null,
    committedQty,
    bindingQty,
    commitments: commitmentRows,
  };
}

export async function getPools(): Promise<PoolRow[]> {
  const pools = await Pool.find({}).sort({ createdAt: -1 }).limit(300);
  const rows: PoolRow[] = [];
  for (const pool of pools) rows.push(await toPoolRow(pool));
  return rows;
}

export async function getPool(poolId: string): Promise<PoolRow> {
  const pool = await Pool.findById(poolId);
  if (!pool) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Pool not found.' });
  return toPoolRow(pool);
}
