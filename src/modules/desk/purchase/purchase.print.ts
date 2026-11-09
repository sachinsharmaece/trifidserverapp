import type { Types } from 'mongoose';
import { Po } from '../../../models/Po.js';
import { PoLine } from '../../../models/PoLine.js';
import { SoLine } from '../../../models/SoLine.js';
import { Sku } from '../../../models/Sku.js';
import { Product } from '../../../models/Product.js';
import { Seller } from '../../../models/Seller.js';
import { Counterparty } from '../../../models/Counterparty.js';
import { Tehsil } from '../../../models/Tehsil.js';
import { getCompanyProfile, PO_TERMS } from '../../../config/company.js';
import { AppError } from '../../../shared/errors.js';
import { assertValidObjectId } from '../../../shared/objectId.js';
import { GST_RATE_PERCENT, computeSellerLineMoney, splitTax } from '../../../shared/pricing.js';
import type { PlaceOfSupply } from '../../../shared/pricing.js';
import { sameDayDeadline } from '../../clocks/clocks.jobs.js';

/**
 * 3 Nov (My view sheet) — what a printed purchase order shows. This only supplies the data: the
 * admin app builds the page and saves the PDF in the browser, so nothing is stored here.
 *
 * It is the seller's document. The rate is his own quoted rate (GST included, per base unit)
 * frozen on the order, a line's amount is boxes × units × that rate, and the taxable value and GST
 * are split out of the total (`computeSellerLineMoney`, DEC-077). No buyer, no buyer rate and no
 * margin appears, so the desk's wall holds (BR-067, BR-069).
 */
export interface PoPrintLine {
  brand: string;
  packLabel: string;
  boxes: number;
  baseUnit: 'LTR' | 'KG' | 'PC';
  baseUnitsPerBox: number;
  ratePaise: number;
  /** The line's amount, GST included. */
  totalPaise: number;
}

export interface PoPrintDto {
  poNo: string;
  releasedAt: string;
  company: { name: string; addressLines: string[]; gstin: string };
  seller: { firm: string; gstin: string | null; addressLines: string[] };
  lines: PoPrintLine[];
  taxablePaise: number;
  gst: {
    ratePercent: number;
    kind: PlaceOfSupply;
    cgstPaise: number;
    sgstPaise: number;
    igstPaise: number;
  };
  totalPaise: number;
  dispatchBy: string;
  terms: string[];
}

const CUTOFF = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A GSTIN opens with the two-digit state code; same state as TriFid means CGST + SGST, else IGST. */
function placeOfSupplyFor(sellerGstin: string | null | undefined, companyGstin: string) {
  if (!sellerGstin || sellerGstin.length < 2) return 'intra_state' as const;
  return sellerGstin.slice(0, 2) === companyGstin.slice(0, 2)
    ? ('intra_state' as const)
    : ('inter_state' as const);
}

export async function getPoPrintData(poId: string): Promise<PoPrintDto> {
  assertValidObjectId(poId, 'poId');
  const po = await Po.findById(poId);
  if (!po) throw new AppError({ code: 'NOT_FOUND', messageEn: 'PO not found.' });

  const [poLines, soLines, seller] = await Promise.all([
    PoLine.find({ poId: po._id }),
    SoLine.find({ soId: po.soId }),
    Seller.findById(po.sellerId),
  ]);
  const counterparty = seller ? await Counterparty.findById(seller.counterpartyId) : null;
  const tehsil = seller?.tehsilId ? await Tehsil.findById(seller.tehsilId) : null;

  const skus = await Sku.find({ _id: { $in: poLines.map((l) => l.skuId) } });
  const skuById = new Map(skus.map((s) => [(s._id as Types.ObjectId).toString(), s]));
  const products = await Product.find({ _id: { $in: skus.map((s) => s.productId) } });
  const productById = new Map(products.map((p) => [(p._id as Types.ObjectId).toString(), p]));
  // The units in a box are frozen on the order line (BR-045), never re-read from the SKU.
  const soLineBySku = new Map(soLines.map((l) => [(l.skuId as Types.ObjectId).toString(), l]));

  const company = getCompanyProfile();
  const sellerGstin = counterparty?.gstin ?? null;
  const placeOfSupply = placeOfSupplyFor(sellerGstin, company.gstin);

  let taxablePaise = 0;
  let totalPaise = 0;
  const lines: PoPrintLine[] = poLines.map((line) => {
    const skuId = (line.skuId as Types.ObjectId).toString();
    const sku = skuById.get(skuId);
    const product = sku ? productById.get((sku.productId as Types.ObjectId).toString()) : undefined;
    const frozen = soLineBySku.get(skuId);
    const baseUnitsPerBox = frozen?.baseUnitsPerBoxAtOrder ?? sku?.baseUnitsPerBox ?? 1;
    const baseUnit = (frozen?.baseUnitAtOrder ?? sku?.baseUnit ?? 'PC') as PoPrintLine['baseUnit'];
    const money = computeSellerLineMoney(
      line.boxes,
      baseUnitsPerBox,
      line.sellerNetPaise,
      placeOfSupply,
    );
    taxablePaise += money.taxablePaise;
    totalPaise += money.totalPaise;
    return {
      brand: product?.brand ?? '—',
      packLabel: sku?.packLabel ?? '—',
      boxes: line.boxes,
      baseUnit,
      baseUnitsPerBox,
      ratePaise: line.sellerNetPaise,
      totalPaise: money.totalPaise,
    };
  });
  const split = splitTax(totalPaise - taxablePaise, placeOfSupply);

  const cutoff = seller?.dispatchCutoffTime;
  const dispatchBy =
    cutoff && CUTOFF.test(cutoff)
      ? sameDayDeadline(po.dispatchDueDate, cutoff)
      : po.dispatchDueDate;

  const place = [tehsil?.name, tehsil?.district].filter(Boolean).join(', ');
  const stateLine = [tehsil?.state, seller?.pincode].filter(Boolean).join(' – ');

  return {
    poNo: po.poNo,
    releasedAt: ((po as { createdAt?: Date }).createdAt ?? po.dispatchDueDate).toISOString(),
    company,
    seller: {
      firm: counterparty?.firm ?? '—',
      gstin: sellerGstin,
      addressLines: [seller?.address, place, stateLine].filter((l): l is string => !!l),
    },
    lines,
    taxablePaise,
    gst: {
      ratePercent: GST_RATE_PERCENT,
      kind: placeOfSupply,
      cgstPaise: split.cgstPaise,
      sgstPaise: split.sgstPaise,
      igstPaise: split.igstPaise,
    },
    totalPaise,
    dispatchBy: dispatchBy.toISOString(),
    terms: [...PO_TERMS],
  };
}
