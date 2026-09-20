/**
 * The wall rules, as pure functions over a parsed JSON body — kept apart from
 * the HTTP sweep so each rule can be proven to fail on a planted violation
 * (`m9WallSweepRules.test.ts`) without editing production code.
 *
 * CH §17.3 / §17.4 / §18.5 / §22.9, PRD §6 invariants 19–22.
 */
export type Audience =
  | 'purchase'
  | 'sales'
  | 'logistics'
  | 'accounts'
  | 'controller'
  | 'founder'
  | 'admin'
  | 'buyer'
  | 'seller';

export interface Identity {
  ids: string[]; // document ids and counterparty ids
  strings: string[]; // firm name, GSTIN, mobile
}

export interface WallWorld {
  identities: { buyer: Identity; seller: Identity };
  soTotalPaise: number;
}

/** Audiences the wall sanctions to see both sides (DEC-032 widened Accounts; Controller/Founder/Admin see all). */
const SEES_BOTH: ReadonlySet<Audience> = new Set(['accounts', 'controller', 'founder', 'admin']);

const BUYER_KEY = /^(buyer|buyerId|buyerName|buyerFirm|buyerGstin|buyerMobile)$/i;
const SELLER_KEY = /^(seller|sellerId|sellerName|sellerFirm|sellerGstin|sellerMobile)$/i;
const SELLER_NET_KEY = /^sellerNet\w*$/i;
// The margin itself, however it is named: `margin…`, or the matrix's own `pct` / `creditPct`.
// (`marginMatrixId` is an id, not a margin.)
const MARGIN_KEY = /^(margin(?!MatrixId)\w*|pct|creditPct)$/i;
const MONEY_KEY = /(paise|rupee|rate|price|amount|total|value|freight|margin)/i;

interface Visit {
  path: string;
  key: string;
  value: unknown;
  parent: Record<string, unknown> | null;
}

function walk(
  node: unknown,
  path: string,
  out: Visit[],
  parent: Record<string, unknown> | null,
): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item, `${path}[${i}]`, out, parent));
    return;
  }
  if (node !== null && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      out.push({ path: `${path}.${k}`, key: k, value: v, parent: obj });
      walk(v, `${path}.${k}`, out, obj);
    }
  }
}

function mentionsIdentity(text: string, identity: Identity): string | null {
  const lower = text.toLowerCase();
  for (const id of identity.ids) if (text.includes(id)) return id;
  for (const s of identity.strings) if (s && lower.includes(s.toLowerCase())) return s;
  return null;
}

/** Every rule that applies to `audience`, run against one response body. Returns human-readable violations. */
export function findWallViolations(audience: Audience, body: unknown, world: WallWorld): string[] {
  const violations: string[] = [];
  const text = JSON.stringify(body ?? null);
  const visits: Visit[] = [];
  walk(body, '$', visits, null);

  // The structural boundary of DEC-032: only the sanctioned audiences may receive
  // ONE object naming both a buyer and a seller. Anyone else resembling the
  // Accounts shape is the wall breaking through a widened type.
  if (!SEES_BOTH.has(audience)) {
    const seen = new Set<Record<string, unknown>>();
    for (const visit of visits) {
      const obj = visit.parent;
      if (!obj || seen.has(obj)) continue;
      seen.add(obj);
      const keys = Object.keys(obj);
      if (keys.some((k) => BUYER_KEY.test(k)) && keys.some((k) => SELLER_KEY.test(k))) {
        violations.push(`${visit.path}: one object names both a buyer and a seller`);
      }
    }
  }

  if (audience === 'purchase') {
    const leaked = mentionsIdentity(text, world.identities.buyer);
    if (leaked) violations.push(`buyer identity value present (${leaked})`);
    for (const v of visits) {
      if (BUYER_KEY.test(v.key)) violations.push(`${v.path}: buyer identity key`);
      if (MARGIN_KEY.test(v.key)) violations.push(`${v.path}: margin key`);
      if (typeof v.value === 'number' && v.value === world.soTotalPaise) {
        violations.push(`${v.path}: the buyer-side order value (${v.value})`);
      }
    }
  }

  if (audience === 'sales') {
    const leaked = mentionsIdentity(text, world.identities.seller);
    if (leaked) violations.push(`seller identity value present (${leaked})`);
    for (const v of visits) {
      if (SELLER_KEY.test(v.key)) violations.push(`${v.path}: seller identity key`);
      if (SELLER_NET_KEY.test(v.key)) violations.push(`${v.path}: seller net key`);
      if (MARGIN_KEY.test(v.key)) violations.push(`${v.path}: margin key`);
    }
  }

  if (audience === 'logistics') {
    for (const side of [world.identities.buyer, world.identities.seller]) {
      const leaked = mentionsIdentity(text, side);
      if (leaked) violations.push(`firm identity value present (${leaked})`);
    }
    for (const v of visits) {
      if (BUYER_KEY.test(v.key) || SELLER_KEY.test(v.key)) {
        violations.push(`${v.path}: firm identity key`);
      }
      if (MONEY_KEY.test(v.key)) violations.push(`${v.path}: money key`);
    }
  }

  if (audience === 'buyer') {
    const leaked = mentionsIdentity(text, world.identities.seller);
    if (leaked) violations.push(`seller identity value present (${leaked})`);
    for (const v of visits) {
      if (SELLER_KEY.test(v.key)) violations.push(`${v.path}: seller identity key`);
      if (SELLER_NET_KEY.test(v.key)) violations.push(`${v.path}: seller net key`);
      if (MARGIN_KEY.test(v.key)) violations.push(`${v.path}: margin key`);
    }
  }

  if (audience === 'seller') {
    const leaked = mentionsIdentity(text, world.identities.buyer);
    if (leaked) violations.push(`buyer identity value present (${leaked})`);
    for (const v of visits) {
      if (BUYER_KEY.test(v.key)) violations.push(`${v.path}: buyer identity key`);
      if (MARGIN_KEY.test(v.key)) violations.push(`${v.path}: margin key`);
    }
  }

  return violations;
}
