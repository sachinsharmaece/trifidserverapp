import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-66 `seller_assignment` — Phase 4, the seller-side twin of
 * `book_assignment` (ENT-15): one assigned purchase executive per seller;
 * no row means the seller is in the Queue. Sellers that existed before
 * Phase 4 start in the Queue. There is no automatic assignment for sellers
 * (no BR-276 equivalent): a person assigns him, at registration, approval
 * or Change owner.
 */
const sellerAssignmentSchema = new Schema(
  {
    sellerId: { type: Schema.Types.ObjectId, ref: 'Seller', required: true, unique: true },
    ownerEmployeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    assignedAt: { type: Date, required: true },
    assignedBy: { type: Schema.Types.ObjectId, required: true },
    reason: { type: String },
  },
  { timestamps: true },
);

sellerAssignmentSchema.index({ ownerEmployeeId: 1 });

export type SellerAssignmentDocument = InferSchemaType<typeof sellerAssignmentSchema>;
export const SellerAssignment = model<SellerAssignmentDocument>(
  'SellerAssignment',
  sellerAssignmentSchema,
  'seller_assignment',
);
