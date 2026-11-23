/** ₹1,234.50 from 123450 paise (Indian grouping). For text the server writes, like history notes. */
export function formatRupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export interface GstSplit {
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
}

/**
 * Works the GST back out of a tax-inclusive amount (rates include tax, BR-02/BR-27; ARCH "Rounding rule").
 *   taxable = round(total × 10,000 ÷ (10,000 + taxBp)), tax = total − taxable.
 *   Another state (inter-state): IGST = tax. Same state: SGST = tax ÷ 2 rounded up, CGST = the rest.
 * The parts always add up to the total exactly.
 * Example: ₹32,400.00 at 18% in Madhya Pradesh → taxable 2,745,763 + CGST 247,118 + SGST 247,119 paise.
 */
export function splitGst(totalPaise: number, taxBp: number, interState: boolean): GstSplit {
  const taxablePaise = Math.round((totalPaise * 10_000) / (10_000 + taxBp));
  const tax = totalPaise - taxablePaise;
  if (interState) return { taxablePaise, cgstPaise: 0, sgstPaise: 0, igstPaise: tax };
  const sgstPaise = Math.ceil(tax / 2);
  return { taxablePaise, cgstPaise: tax - sgstPaise, sgstPaise, igstPaise: 0 };
}
