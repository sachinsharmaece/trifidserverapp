import { randomUUID } from 'node:crypto';
import type { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { FileModel } from '../../models/File.js';
import { AppError } from '../../shared/errors.js';
import type { AccessTokenClaims } from '../../shared/tokens.js';

/**
 * ARCHITECTURE.md §M1 scope — "real object storage can wait; the shape and
 * the route contracts must exist." This returns a stub pre-signed URL shaped
 * like a real one so the frontend can be built against the final contract;
 * swapping in real S3/MinIO signing later only touches this file.
 */
export async function createUploadTarget(
  mime: string,
  sizeBytes: number,
  auth: AccessTokenClaims,
): Promise<{ fileId: string; uploadUrl: string }> {
  if (sizeBytes > env.fileMaxBytes) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: `File exceeds the ${env.fileMaxBytes} byte limit.`,
      field: 'sizeBytes',
    });
  }

  const key = `${auth.actorType}/${auth.sub}/${randomUUID()}`;
  const file = await FileModel.create({
    bucket: env.fileStorageBucket,
    key,
    mime,
    sizeBytes,
    scanState: 'pending',
    uploadedBy: auth.sub,
  });

  const uploadUrl = `${env.fileStorageEndpoint}/${env.fileStorageBucket}/${key}?stub-presigned=true`;
  return { fileId: (file._id as Types.ObjectId).toString(), uploadUrl };
}

export async function findFileOwner(fileId: string): Promise<{ counterpartyId: string } | null> {
  const file = await FileModel.findById(fileId);
  if (!file) return null;
  return { counterpartyId: file.uploadedBy.toString() };
}

export async function createDownloadUrl(
  fileId: string,
): Promise<{ downloadUrl: string; expiresIn: number }> {
  const file = await FileModel.findById(fileId);
  if (!file) {
    throw new AppError({ code: 'NOT_VISIBLE', messageEn: 'Not found.' });
  }
  const expiresIn = 300;
  const downloadUrl = `${env.fileStorageEndpoint}/${file.bucket}/${file.key}?stub-signed=true&expiresIn=${expiresIn}`;
  return { downloadUrl, expiresIn };
}
