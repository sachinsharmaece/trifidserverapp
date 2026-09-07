import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-15 `book_assignment`. BR-261 — a book is a set of customers with one
 * named owner. BR-276 — queue → book is triggered automatically on a
 * buyer's first order; that trigger belongs in `modules/chain` (M4), where
 * orders start existing. It cannot be wired against nothing, so M3 ships
 * only the manual admin/Sales-head action below.
 */
const bookAssignmentSchema = new Schema(
  {
    buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true, unique: true },
    ownerEmployeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    assignedAt: { type: Date, required: true },
    assignedBy: { type: Schema.Types.ObjectId, required: true },
    reason: { type: String },
  },
  { timestamps: true },
);

export type BookAssignmentDocument = InferSchemaType<typeof bookAssignmentSchema>;
export const BookAssignment = model<BookAssignmentDocument>(
  'BookAssignment',
  bookAssignmentSchema,
  'book_assignment',
);
