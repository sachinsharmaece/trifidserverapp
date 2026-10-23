import { Schema, model } from 'mongoose';
/**
 * ENT-68 `staff_notice` — Phase 6. The in-app notice for a staff member (the
 * bell in the admin app). The notifications module messages buyers and
 * sellers on WhatsApp only; this is the staff side, kept deliberately small:
 * a title, a line of text, where it points, and whether it was read.
 */
const staffNoticeSchema = new Schema({
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    kind: {
        type: String,
        enum: ['push_received', 'push_approved', 'push_rejected'],
        required: true,
    },
    title: { type: String, required: true },
    body: { type: String, required: true },
    // An admin-app path, e.g. /purchase/from-sales/<pushId>.
    link: { type: String, default: null },
    readAt: { type: Date, default: null },
}, { timestamps: true });
staffNoticeSchema.index({ employeeId: 1, createdAt: -1 });
export const StaffNotice = model('StaffNotice', staffNoticeSchema, 'staff_notice');
