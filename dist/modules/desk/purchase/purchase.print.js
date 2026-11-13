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
import { sameDayDeadline } from '../../clocks/clocks.jobs.js';
const CUTOFF = /^([01]\d|2[0-3]):[0-5]\d$/;
/** A GSTIN opens with the two-digit state code; same state as TriFid means CGST + SGST, else IGST. */
function placeOfSupplyFor(sellerGstin, companyGstin) {
    if (!sellerGstin || sellerGstin.length < 2)
        return 'intra_state';
    return sellerGstin.slice(0, 2) === companyGstin.slice(0, 2)
        ? 'intra_state'
        : 'inter_state';
}
export async function getPoPrintData(poId) {
    assertValidObjectId(poId, 'poId');
    const po = await Po.findById(poId);
    if (!po)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'PO not found.' });
    const [poLines, soLines, seller] = await Promise.all([
        PoLine.find({ poId: po._id }),
        SoLine.find({ soId: po.soId }),
        Seller.findById(po.sellerId),
    ]);
    const counterparty = seller ? await Counterparty.findById(seller.counterpartyId) : null;
    const tehsil = seller?.tehsilId ? await Tehsil.findById(seller.tehsilId) : null;
    const skus = await Sku.find({ _id: { $in: poLines.map((l) => l.skuId) } });
    const skuById = new Map(skus.map((s) => [s._id.toString(), s]));
    const products = await Product.find({ _id: { $in: skus.map((s) => s.productId) } });
    const productById = new Map(products.map((p) => [p._id.toString(), p]));
    // The units in a box are frozen on the order line (BR-045), never re-read from the SKU.
    const soLineBySku = new Map(soLines.map((l) => [l.skuId.toString(), l]));
    const company = getCompanyProfile();
    const sellerGstin = counterparty?.gstin ?? null;
    const placeOfSupply = placeOfSupplyFor(sellerGstin, company.gstin);
    let taxablePaise = 0;
    let totalPaise = 0;
    const lines = poLines.map((line) => {
        const skuId = line.skuId.toString();
        const sku = skuById.get(skuId);
        const product = sku ? productById.get(sku.productId.toString()) : undefined;
        const frozen = soLineBySku.get(skuId);
        const baseUnitsPerBox = frozen?.baseUnitsPerBoxAtOrder ?? sku?.baseUnitsPerBox ?? 1;
        const baseUnit = (frozen?.baseUnitAtOrder ?? sku?.baseUnit ?? 'PC');
        const money = computeSellerLineMoney(line.boxes, baseUnitsPerBox, line.sellerNetPaise, placeOfSupply);
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
    const dispatchBy = cutoff && CUTOFF.test(cutoff)
        ? sameDayDeadline(po.dispatchDueDate, cutoff)
        : po.dispatchDueDate;
    const place = [tehsil?.name, tehsil?.district].filter(Boolean).join(', ');
    const stateLine = [tehsil?.state, seller?.pincode].filter(Boolean).join(' – ');
    return {
        poNo: po.poNo,
        releasedAt: (po.createdAt ?? po.dispatchDueDate).toISOString(),
        company,
        seller: {
            firm: counterparty?.firm ?? '—',
            gstin: sellerGstin,
            addressLines: [seller?.address, place, stateLine].filter((l) => !!l),
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
