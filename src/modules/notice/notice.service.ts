import type { ClientSession, Types } from 'mongoose';
import { StaffNotice, type StaffNoticeDocument } from '../../models/StaffNotice.js';
import { AppError } from '../../shared/errors.js';

/**
 * Phase 6 — in-app notices for staff (ENT-68). Written inside the business
 * transaction they describe, so a notice never outlives a rolled-back action.
 */
export interface NoticeInput {
  kind: StaffNoticeDocument['kind'];
  title: string;
  body: string;
  link?: string | null;
}

/** One notice per person — the same person named twice is told once. */
export async function notifyStaff(
  employeeIds: Array<string | Types.ObjectId | null | undefined>,
  notice: NoticeInput,
  session?: ClientSession,
): Promise<number> {
  const unique = [...new Set(employeeIds.filter(Boolean).map(String))];
  if (unique.length === 0) return 0;
  await StaffNotice.create(
    unique.map((employeeId) => ({ employeeId, ...notice, link: notice.link ?? null })),
    { session, ordered: true },
  );
  return unique.length;
}

export interface StaffNoticeDto {
  noticeId: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  read: boolean;
  createdAt: string;
}

export async function listMyNotices(
  employeeId: string,
  limit = 30,
): Promise<{ items: StaffNoticeDto[]; unread: number }> {
  const [rows, unread] = await Promise.all([
    StaffNotice.find({ employeeId }).sort({ createdAt: -1 }).limit(limit),
    StaffNotice.countDocuments({ employeeId, readAt: null }),
  ]);
  return {
    items: rows.map((n) => ({
      noticeId: String(n._id),
      kind: n.kind,
      title: n.title,
      body: n.body,
      link: n.link ?? null,
      read: Boolean(n.readAt),
      createdAt: (n as unknown as { createdAt: Date }).createdAt.toISOString(),
    })),
    unread,
  };
}

export async function markRead(employeeId: string, noticeId: string): Promise<void> {
  const result = await StaffNotice.updateOne(
    { _id: noticeId, employeeId },
    { $set: { readAt: new Date() } },
  );
  if (result.matchedCount === 0) {
    throw new AppError({ code: 'NOT_FOUND', messageEn: 'Notice not found.' });
  }
}

export async function markAllRead(employeeId: string): Promise<void> {
  await StaffNotice.updateMany({ employeeId, readAt: null }, { $set: { readAt: new Date() } });
}
