import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-55 `file`. Shape and route contracts only for this session — real object
 * storage integration is a later milestone (ARCHITECTURE.md §8 file upload
 * requirements: pre-signed direct upload, magic-byte check, size cap, EXIF
 * stripped, malware scan, opaque keys, short-lived signed download).
 */
const fileSchema = new Schema(
  {
    bucket: { type: String, required: true },
    key: { type: String, required: true, unique: true },
    mime: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    sha256: { type: String },
    scanState: {
      type: String,
      enum: ['pending', 'clean', 'infected'],
      default: 'pending',
      required: true,
    },
    uploadedBy: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: { createdAt: 'uploadedAt', updatedAt: true } },
);

export type FileDocument = InferSchemaType<typeof fileSchema>;
export const FileModel = model<FileDocument>('File', fileSchema, 'file');
