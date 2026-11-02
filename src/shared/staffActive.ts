import { Employee } from '../models/Employee.js';

/**
 * Phase 2 — a switched-off employee is out within seconds, not when his
 * 15-minute access token runs out (TD-006). `authenticate` asks here on
 * every staff request; the answer is cached per employee for 30 seconds so
 * this is at most one small read per person per half-minute. Deactivate and
 * reactivate drop the cached answer at once (`forgetStaffActive`).
 */
const TTL_MS = 30_000;
const cache = new Map<string, { active: boolean; at: number }>();

export async function isStaffActive(employeeId: string): Promise<boolean> {
  const hit = cache.get(employeeId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.active;
  const employee = await Employee.findById(employeeId, { active: 1 }).lean();
  const active = Boolean(employee?.active);
  cache.set(employeeId, { active, at: Date.now() });
  return active;
}

export function forgetStaffActive(employeeId: string): void {
  cache.delete(employeeId);
}
