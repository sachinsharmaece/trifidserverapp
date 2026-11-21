import { isValidObjectId, type Types } from 'mongoose';
import { z } from 'zod';
import { ManufacturerModel, TehsilModel } from '../../models/index.js';
import { badRequest } from '../../shared/errors.js';
import { isValidGstin } from '../../shared/validators.js';

/** Request rules and small helpers used by both the sellers and the buyers API. */

export const objectId = z.string().refine(isValidObjectId, 'Choose a value from the list.');

/** A 10-digit mobile number. Spaces and dashes are dropped: "98765 43210" is fine. */
export const mobileField = z
  .string()
  .trim()
  .transform((text) => text.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^\d{10}$/, 'A mobile number has 10 digits.'));

export const gstinField = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isValidGstin, 'This is not a valid GSTIN. Check the letters, digits and last character.');

/** Optional text. An empty text means "nothing", so on update it clears the value. */
export const optionalText = (max: number) => z.string().trim().max(max);

/** The manufacturers a party is a dealer of. Repeats are dropped. */
export const manufacturerIdsField = z
  .array(objectId)
  .max(200, 'Too many manufacturers.')
  .transform((ids) => [...new Set(ids)]);

/** The search and paging parts of a list request (?q=&page=&pageSize=), shared by every list. */
export const pagingShape = {
  q: z.string().trim().max(100).default(''),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};

/** The query of the seller and buyer lists. `active=true` or `false` shows only the ones that are on or off. */
export const listQuery = z.object({
  ...pagingShape,
  active: z.enum(['true', 'false']).optional(),
});

/** The new id if it differs from the current one, otherwise undefined (so an old, turned-off value can stay). */
export function ifChanged(newId: string | undefined, currentId: unknown): string | undefined {
  return newId !== undefined && newId !== String(currentId) ? newId : undefined;
}

/** The chosen tehsil must exist and be active. */
export async function checkTehsil(tehsilId: string): Promise<void> {
  const tehsil = await TehsilModel.findById(tehsilId);
  if (!tehsil?.active) throw badRequest('Choose an active tehsil.');
}

/** Every chosen manufacturer must exist and be active. */
export async function checkManufacturers(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const found = await ManufacturerModel.countDocuments({ _id: { $in: ids }, active: true });
  if (found !== ids.length) throw badRequest('Choose active manufacturers from the list.');
}

/** The ids in `wanted` that `current` does not hold yet. Only these need to be active (old ones may be turned off). */
export function newlyAdded(
  wanted: string[] | undefined,
  current: readonly Types.ObjectId[],
): string[] {
  return (wanted ?? []).filter((id) => !current.some((held) => held.equals(id)));
}

export interface TehsilSummary {
  id: string;
  name: string;
  district: string;
  state: string;
}

/** A tehsil's name, district and state for each id, so the lists can show "Mhow, Indore, Madhya Pradesh". */
export async function tehsilSummaries(ids: unknown[]): Promise<Map<string, TehsilSummary>> {
  const tehsils = await TehsilModel.find({ _id: { $in: ids } });
  return new Map(
    tehsils.map((tehsil) => [
      tehsil.id,
      { id: tehsil.id, name: tehsil.name, district: tehsil.district, state: tehsil.state },
    ]),
  );
}
