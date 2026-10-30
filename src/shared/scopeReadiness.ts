import { Employee } from '../models/Employee.js';
import { Role } from '../models/Role.js';
import { Buyer } from '../models/Buyer.js';
import { Seller } from '../models/Seller.js';
import { BookAssignment } from '../models/BookAssignment.js';
import { SellerAssignment } from '../models/SellerAssignment.js';

/**
 * Phase 7 — is the data ready for OWNERSHIP_SCOPE_ENFORCED (BR-360)? Read
 * only. With the flag on, scope comes from positions, reporting lines and
 * "works for" teams; anyone missing them sees only the leads assigned to
 * him. This lists who that would be, so Admin can fix it on the Team page
 * first.
 */
export interface ScopeReadiness {
  ready: boolean;
  /** Holds the Sales or Purchase role but no position. */
  noPosition: string[];
  /** An executive with nobody to report to on that side. */
  noLeader: string[];
  /** Accounts / Logistics with neither "works for" teams nor "all teams". */
  noTeams: string[];
  /** Leads nobody owns — only leaders and Admin will see them. */
  buyersInQueue: number;
  sellersInQueue: number;
}

export async function scopeReadiness(): Promise<ScopeReadiness> {
  const roles = await Role.find(
    { key: { $in: ['sales', 'purchase', 'accounts', 'transport_logistics'] } },
    { key: 1 },
  );
  const roleId = (key: string) => roles.find((r) => r.key === key)?._id;
  const has = (e: { roleIds?: unknown[] }, key: string) =>
    (e.roleIds ?? []).some((id) => String(id) === String(roleId(key)));

  const staff = await Employee.find(
    { active: true },
    {
      person: 1,
      roleIds: 1,
      positions: 1,
      reportsToSalesLeaderId: 1,
      reportsToPurchaseLeaderId: 1,
      worksForTeamLeaderIds: 1,
      worksForAllTeams: 1,
    },
  ).sort({ person: 1 });

  const noPosition: string[] = [];
  const noLeader: string[] = [];
  const noTeams: string[] = [];
  for (const e of staff) {
    const positions = e.positions ?? [];
    if ((has(e, 'sales') || has(e, 'purchase')) && positions.length === 0)
      noPosition.push(e.person);
    if (positions.includes('SALES_EXEC') && !e.reportsToSalesLeaderId) {
      noLeader.push(`${e.person} (Sales)`);
    }
    // DEC-066 — a Sales Leader reports to Admin on the Purchase side.
    if (
      positions.includes('PURCHASE_EXEC') &&
      !positions.includes('SALES_LEADER') &&
      !e.reportsToPurchaseLeaderId
    ) {
      noLeader.push(`${e.person} (Purchase)`);
    }
    if (
      (has(e, 'accounts') || has(e, 'transport_logistics')) &&
      !e.worksForAllTeams &&
      (e.worksForTeamLeaderIds ?? []).length === 0
    ) {
      noTeams.push(e.person);
    }
  }

  const [buyers, owned, sellers, ownedSellers] = await Promise.all([
    Buyer.countDocuments(),
    BookAssignment.countDocuments(),
    Seller.countDocuments(),
    SellerAssignment.countDocuments(),
  ]);
  return {
    ready: noPosition.length === 0 && noLeader.length === 0 && noTeams.length === 0,
    noPosition,
    noLeader,
    noTeams,
    buyersInQueue: Math.max(0, buyers - owned),
    sellersInQueue: Math.max(0, sellers - ownedSellers),
  };
}
