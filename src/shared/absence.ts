import type { Types } from 'mongoose';
import { Absence } from '../models/Absence.js';

/**
 * BR-263/BR-264 — absence cover, shared by the lane board (admin.service.ts)
 * and, from Phase 5, lead visibility (shared/scope.ts): while someone is
 * away, whoever covers him also sees his leads.
 */

// The window during which an absence is "in effect".
export function isAbsenceActiveNow(absence: { from: Date; returnDate: Date }, now: Date): boolean {
  return absence.from.getTime() <= now.getTime() && absence.returnDate.getTime() >= now.getTime();
}

/**
 * BR-264 — cover follows the chain. Where A is covered by B, and B is then
 * also covered by C, A resolves to C, not to an empty chair. `activeById`
 * is the currently-active-absence lookup, built once per call site so a
 * lane-board listing does not re-query per lane.
 */
export function resolveEffectiveHolder(
  employeeId: Types.ObjectId,
  activeAbsenceByEmployeeId: Map<string, { coveredBy: Types.ObjectId }>,
): Types.ObjectId {
  let current = employeeId;
  const visited = new Set([current.toString()]);
  for (let hops = 0; hops < 50; hops += 1) {
    const absence = activeAbsenceByEmployeeId.get(current.toString());
    if (!absence) return current;
    const next = absence.coveredBy;
    if (visited.has(next.toString())) return current; // guarded at creation time — should not happen
    visited.add(next.toString());
    current = next;
  }
  return current;
}

/** Phase 5 — everyone away right now whose cover (through the chain) lands on this person. */
export async function employeesCoveredBy(employeeId: string, now = new Date()): Promise<string[]> {
  const active = (await Absence.find({ from: { $lte: now }, returnDate: { $gte: now } })).filter(
    (a) => isAbsenceActiveNow(a, now),
  );
  const byEmployee = new Map(
    active.map((a) => [String(a.employeeId), { coveredBy: a.coveredBy as Types.ObjectId }]),
  );
  return active
    .filter(
      (a) =>
        String(resolveEffectiveHolder(a.employeeId as Types.ObjectId, byEmployee)) === employeeId,
    )
    .map((a) => String(a.employeeId));
}
