import { Router } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import {
  PurchaseOrderModel,
  TehsilModel,
  TransporterModel,
  UploadedFileModel,
  VehicleOwnerModel,
} from '../../models/index.js';
import { writeAudit } from '../../shared/audit.js';
import { encryptText } from '../../shared/encryption.js';
import { conflict, forbidden, invalidField, notFound } from '../../shared/errors.js';
import { normaliseKey } from '../../shared/validators.js';
import { currentUserOf, requireAuth } from '../auth/requireAuth.js';
import { requireRole } from '../auth/requireRole.js';

/**
 * The reference's Logistics extras (reference-copy branch):
 *
 *   POST /uploads { name, contentType, dataBase64 }   -> 201 { fileId }   (a photo or PDF, at most 5 MB)
 *   GET  /files/:id                                   the file itself
 *   GET  /vehicle-owners                              { vehicleOwners, canCreate }
 *   POST /vehicle-owners { name, mobile, vehicleNumber, vehicleType, capacity?, homeAreaId? }  (Logistics Head)
 *   GET  /vehicles                                    { vehicles }  active, newest first, Aadhaar last 4 only
 *   POST /vehicles { name, mobile, vehicleNumber, vehicleType, seatingArea?, aadhaar, licenceNo?, photos? }
 *   GET  /transporters, POST /transporters { name }
 *   POST /dock/:id/photos { kind: ARRIVAL | INSPECTION, fileIds }   the photos the dock took
 */
export const logisticsRouter: Router = Router();

const DESK = ['LOGISTICS', 'CONTROLLER', 'FOUNDER', 'ADMIN'] as const;
const objectId = z.string().refine(isValidObjectId, 'Select a valid item');
const MAX_BYTES = 5 * 1024 * 1024;

/** Drops the fields left empty, so optional ones are simply not saved. */
const defined = (input: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== ''),
  );

logisticsRouter.post('/uploads', requireAuth, async (req, res) => {
  const body = z
    .object({
      name: z.string().trim().min(1).max(200),
      contentType: z.enum(
        ['image/jpeg', 'image/png', 'application/pdf'],
        'Use a JPG, PNG or PDF file.',
      ),
      dataBase64: z.string().min(1),
    })
    .parse(req.body);
  const bytes = Buffer.from(body.dataBase64, 'base64').length;
  if (bytes === 0) throw invalidField('dataBase64', 'The file is empty.');
  if (bytes > MAX_BYTES) throw invalidField('dataBase64', 'The file is larger than 5 MB.');
  const file = await UploadedFileModel.create({ ...body, bytes, by: currentUserOf(req).id });
  res.status(201).json({ fileId: file.id });
});

logisticsRouter.get('/files/:id', requireAuth, async (req, res) => {
  const file = isValidObjectId(req.params.id)
    ? await UploadedFileModel.findById(req.params.id).select('+dataBase64')
    : null;
  if (!file) throw notFound('File not found.');
  res.setHeader('content-type', file.contentType);
  res.setHeader('content-disposition', `inline; filename="${file.name.replace(/"/g, '')}"`);
  res.send(Buffer.from(file.dataBase64, 'base64'));
});

// ---------- vehicle owners ----------
logisticsRouter.use(
  ['/vehicle-owners', '/vehicles', '/transporters'],
  requireAuth,
  requireRole(...DESK),
);

async function homeAreas(ids: unknown[]) {
  const tehsils = await TehsilModel.find({ _id: { $in: ids.filter(Boolean) } });
  return new Map(
    tehsils.map((t) => [t.id, { id: t.id, name: t.name, district: t.district, state: t.state }]),
  );
}

logisticsRouter.get('/vehicle-owners', async (req, res) => {
  const me = currentUserOf(req);
  const owners = await VehicleOwnerModel.find().sort({ name: 1 });
  const areas = await homeAreas(owners.map((o) => o.homeAreaId));
  res.json({
    vehicleOwners: owners.map((o) => ({
      id: o.id,
      name: o.name,
      mobile: o.mobile,
      vehicleNumber: o.vehicleNumber,
      vehicleType: o.vehicleType,
      capacity: o.capacity ?? null,
      homeArea: o.homeAreaId ? (areas.get(String(o.homeAreaId)) ?? null) : null,
      status: o.status,
    })),
    canCreate: me.role !== 'LOGISTICS' || me.position === 'LOGISTICS_HEAD',
  });
});

const mobile = z
  .string()
  .trim()
  .regex(/^\d{10}$/, 'Mobile must be exactly 10 digits');
const vehicleNumber = z
  .string()
  .trim()
  .min(1, 'Vehicle number is required')
  .max(20)
  .transform((t) => t.toUpperCase().replace(/\s+/g, ' '));

async function assertNewVehicle(number: string) {
  if (await VehicleOwnerModel.exists({ vehicleNumber: number })) {
    throw conflict('A vehicle with this number is already registered');
  }
}

logisticsRouter.post('/vehicle-owners', async (req, res) => {
  const me = currentUserOf(req);
  if (me.role === 'LOGISTICS' && me.position !== 'LOGISTICS_HEAD') {
    throw forbidden('Only a Logistics Head can create a vehicle-owner entry');
  }
  const input = z
    .object({
      name: z.string().trim().min(1, 'Name is required').max(120),
      mobile,
      vehicleNumber,
      vehicleType: z.string().trim().min(1, 'Vehicle type is required').max(60),
      capacity: z.string().trim().max(60).optional(),
      homeAreaId: objectId.optional(),
    })
    .parse(req.body);
  await assertNewVehicle(input.vehicleNumber);
  const owner = await VehicleOwnerModel.create({ ...defined(input), createdBy: me.id });
  await writeAudit(req, {
    action: 'vehicleOwner.create',
    entityType: 'VehicleOwner',
    entityId: owner.id,
    after: { name: owner.name },
  });
  res.status(201).json({ vehicleOwner: { id: owner.id, name: owner.name } });
});

logisticsRouter.get('/vehicles', async (_req, res) => {
  const vehicles = await VehicleOwnerModel.find({ status: 'ACTIVE' }).sort({ createdAt: -1 });
  res.json({
    vehicles: vehicles.map((v) => ({
      id: v.id,
      owner: v.name,
      mobile: v.mobile,
      vehicleNo: v.vehicleNumber,
      type: v.vehicleType,
      seatingArea: v.seatingArea ?? null,
      aadhaarLast4: v.aadhaarLast4 ?? null,
      licenceNo: v.licenceNo ?? null,
      hasDriverPhoto: Boolean(v.driverPhotoFileId),
      hasVehiclePhoto: Boolean(v.vehiclePhotoFileId),
    })),
  });
});

logisticsRouter.post('/vehicles', async (req, res) => {
  const input = z
    .object({
      name: z.string().trim().min(1, 'Owner / driver name is required').max(120),
      mobile,
      vehicleNumber,
      vehicleType: z.string().trim().min(1, 'Vehicle type is required').max(60),
      seatingArea: z.string().trim().max(120).optional(),
      aadhaar: z
        .string()
        .transform((t) => t.replace(/\D/g, ''))
        .pipe(z.string().length(12, 'Aadhaar must be exactly 12 digits')),
      licenceNo: z.string().trim().max(40).optional(),
      driverPhotoFileId: objectId.optional(),
      vehiclePhotoFileId: objectId.optional(),
    })
    .parse(req.body);
  await assertNewVehicle(input.vehicleNumber);
  const { aadhaar, ...rest } = input;
  const vehicle = await VehicleOwnerModel.create({
    ...defined(rest),
    aadhaarEnc: encryptText(aadhaar),
    aadhaarLast4: aadhaar.slice(-4),
    createdBy: currentUserOf(req).id,
  });
  await writeAudit(req, {
    action: 'vehicle.create',
    entityType: 'VehicleOwner',
    entityId: vehicle.id,
    after: { vehicleNumber: vehicle.vehicleNumber },
  });
  res.status(201).json({ vehicleId: vehicle.id });
});

// ---------- transporters ----------
logisticsRouter.get('/transporters', async (_req, res) => {
  const list = await TransporterModel.find().sort({ name: 1 });
  res.json({ transporters: list.map((t) => ({ id: t.id, name: t.name })) });
});

logisticsRouter.post('/transporters', async (req, res) => {
  const { name } = z
    .object({ name: z.string().trim().min(1, 'Enter the transporter name').max(120) })
    .parse(req.body);
  const nameKey = normaliseKey(name);
  if (await TransporterModel.exists({ nameKey }))
    throw conflict('This transporter is already on the list.');
  const t = await TransporterModel.create({ name, nameKey, createdBy: currentUserOf(req).id });
  res.status(201).json({ transporter: { id: t.id, name: t.name } });
});

// ---------- dock photos ----------
logisticsRouter.post(
  '/dock/:id/photos',
  requireAuth,
  requireRole('LOGISTICS', 'FOUNDER', 'ADMIN'),
  async (req, res) => {
    const body = z
      .object({
        kind: z.enum(['ARRIVAL', 'INSPECTION']),
        fileIds: z.array(objectId).min(1).max(20),
      })
      .parse(req.body);
    const po = isValidObjectId(req.params.id)
      ? await PurchaseOrderModel.findById(req.params.id)
      : null;
    if (!po) throw notFound('Purchase order not found.');
    const found = await UploadedFileModel.countDocuments({ _id: { $in: body.fileIds } });
    if (found !== body.fileIds.length) throw invalidField('fileIds', 'Upload the photo first.');
    await PurchaseOrderModel.updateOne(
      { _id: po._id },
      body.kind === 'ARRIVAL'
        ? { $set: { arrivalPhotoFileId: body.fileIds[0] } }
        : { $set: { inspectionPhotoFileIds: body.fileIds } },
    );
    res.json({ ok: true });
  },
);
