import { StaffNotice } from '../../models/StaffNotice.js';
import { AppError } from '../../shared/errors.js';
/** One notice per person — the same person named twice is told once. */
export async function notifyStaff(employeeIds, notice, session) {
    const unique = [...new Set(employeeIds.filter(Boolean).map(String))];
    if (unique.length === 0)
        return 0;
    await StaffNotice.create(unique.map((employeeId) => ({ employeeId, ...notice, link: notice.link ?? null })), { session, ordered: true });
    return unique.length;
}
export async function listMyNotices(employeeId, limit = 30) {
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
            createdAt: n.createdAt.toISOString(),
        })),
        unread,
    };
}
export async function markRead(employeeId, noticeId) {
    const result = await StaffNotice.updateOne({ _id: noticeId, employeeId }, { $set: { readAt: new Date() } });
    if (result.matchedCount === 0) {
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Notice not found.' });
    }
}
export async function markAllRead(employeeId) {
    await StaffNotice.updateMany({ employeeId, readAt: null }, { $set: { readAt: new Date() } });
}
