import { Schema, model, type InferSchemaType } from 'mongoose';
import { refField, textField } from './_fields.js';

/**
 * Someone who carries TriFid goods (reference-copy branch; reference VehicleOwner, LOCK-37 §4.5 and LOCK-40 L40.16).
 * Not staff: no login. The Aadhaar number is kept locked; only its last 4 digits are ever sent out.
 */
const vehicleOwnerSchema = new Schema(
  {
    name: { ...textField(120), required: true },
    mobile: { type: String, required: true, match: /^\d{10}$/ },
    vehicleNumber: { ...textField(20), required: true },
    vehicleType: { ...textField(60), required: true },
    capacity: textField(60),
    homeAreaId: refField('Tehsil'),
    seatingArea: textField(120),
    aadhaarEnc: { type: String, select: false },
    aadhaarLast4: { type: String, match: /^\d{4}$/ },
    licenceNo: textField(40),
    driverPhotoFileId: refField('UploadedFile'),
    vehiclePhotoFileId: refField('UploadedFile'),
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], required: true, default: 'ACTIVE' },
    createdBy: { ...refField('User'), required: true },
  },
  { collection: 'vehicle_owners', timestamps: true, versionKey: false },
);

vehicleOwnerSchema.index({ vehicleNumber: 1 }, { unique: true });

export type VehicleOwner = InferSchemaType<typeof vehicleOwnerSchema>;
export const VehicleOwnerModel = model('VehicleOwner', vehicleOwnerSchema);
