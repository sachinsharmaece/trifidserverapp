import { Schema, model, type InferSchemaType } from 'mongoose';
import { refField, textField } from './_fields.js';

/**
 * A photo or document someone uploaded (reference-copy branch; reference UploadedFile): truck/cases photo at
 * arrival, inspection photos, the LR/receipt photo, vehicle and driver photos. Kept in the database as base64
 * (at most 5 MB), so nothing else needs setting up. Never deleted.
 */
const uploadedFileSchema = new Schema(
  {
    name: { ...textField(200), required: true },
    contentType: {
      type: String,
      required: true,
      enum: ['image/jpeg', 'image/png', 'application/pdf'],
    },
    bytes: { type: Number, required: true, min: 1, max: 5 * 1024 * 1024 },
    dataBase64: { type: String, required: true, select: false },
    by: { ...refField('User'), required: true },
  },
  { collection: 'uploaded_files', timestamps: true, versionKey: false },
);

export type UploadedFile = InferSchemaType<typeof uploadedFileSchema>;
export const UploadedFileModel = model('UploadedFile', uploadedFileSchema);
