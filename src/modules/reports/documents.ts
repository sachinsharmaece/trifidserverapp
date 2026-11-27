import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { CompanyModel } from '../../models/index.js';
import { conflict } from '../../shared/errors.js';
import { formatRupees } from '../../shared/money.js';
import type { PurchaseOrderDoc } from '../purchaseOrders/purchaseOrders.js';
import type { SalesOrderDoc } from '../salesOrders/salesOrders.js';

/**
 * The two printed documents (SRS-RPT-01):
 *   - the proforma for a sales order: TriFid's details, the BUYER, the lines at the buyer's rate, the GST split
 *     and the total. It never shows the seller, his rate or our margin.
 *   - the purchase order for a PO: TriFid's details, the SELLER and his rates. It never shows the buyer, the
 *     buyer's rate or the margin.
 * Each is built only from its own side's record, so a mix-up is not possible: the sales order has the buyer,
 * the PO has the seller. (The sales order also stores the seller's rate for the supervisors; the proforma never
 * reads that field.)
 *
 * The standard PDF fonts cannot draw ₹ or Hindi letters, so money is written "Rs. 1,234.50" and any letter the
 * font cannot draw is written as "?".
 */

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 40;
const GREY = rgb(0.4, 0.4, 0.4);
const LINE = rgb(0.8, 0.8, 0.8);

/** Makes text safe for the standard fonts (WinAnsi): Rs. for the rupee sign, "?" for what cannot be drawn. */
function safe(text: string): string {
  return text
    .replace(/\u20B9/g, 'Rs. ')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^\x20-\x7E\u00A1-\u00FF]/g, '?');
}

const rs = (paise: number) => safe(formatRupees(paise));

/** 1800 → "18%", 250 → "2.5%". */
const percent = (bp: number) => `${Number((bp / 100).toFixed(2))}%`;

/** "2026-11-27" for an instant, in Indian time. */
const istDay = (at: Date) =>
  new Date(at.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** A tiny page writer: it keeps the pen position and starts a new page when the next block will not fit. */
class Sheet {
  readonly doc: PDFDocument;
  page: PDFPage;
  y: number;
  private constructor(
    doc: PDFDocument,
    readonly regular: PDFFont,
    readonly bold: PDFFont,
  ) {
    this.doc = doc;
    this.page = doc.addPage([PAGE.width, PAGE.height]);
    this.y = PAGE.height - MARGIN;
  }

  static async create(title: string) {
    const doc = await PDFDocument.create();
    doc.setTitle(safe(title));
    doc.setCreator('TriFid');
    return new Sheet(
      doc,
      await doc.embedFont(StandardFonts.Helvetica),
      await doc.embedFont(StandardFonts.HelveticaBold),
    );
  }

  /** Words broken into lines no wider than `width`. */
  wrap(text: string, width: number, size: number, font = this.regular): string[] {
    const lines: string[] = [];
    for (const paragraph of safe(text).split('\n')) {
      let line = '';
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word;
        if (line && font.widthOfTextAtSize(next, size) > width) {
          lines.push(line);
          line = word;
        } else {
          line = next;
        }
      }
      lines.push(line);
    }
    return lines;
  }

  /** Makes room for a block `height` tall, starting a new page if needed. */
  room(height: number) {
    if (this.y - height < MARGIN) {
      this.page = this.doc.addPage([PAGE.width, PAGE.height]);
      this.y = PAGE.height - MARGIN;
    }
  }

  /** One line of text at x; `right` puts the END of the text at x. Does not move the pen. */
  put(
    text: string,
    x: number,
    options: { size?: number; bold?: boolean; right?: boolean; grey?: boolean } = {},
  ) {
    const size = options.size ?? 10;
    const font = options.bold ? this.bold : this.regular;
    const clean = safe(text);
    const at = options.right ? x - font.widthOfTextAtSize(clean, size) : x;
    this.page.drawText(clean, {
      x: at,
      y: this.y - size,
      size,
      font,
      color: options.grey ? GREY : rgb(0, 0, 0),
    });
  }

  /** Wrapped text on the left; moves the pen below it. */
  paragraph(
    text: string,
    options: { size?: number; bold?: boolean; grey?: boolean; width?: number } = {},
  ) {
    const size = options.size ?? 10;
    const lines = this.wrap(
      text,
      options.width ?? PAGE.width - 2 * MARGIN,
      size,
      options.bold ? this.bold : this.regular,
    );
    for (const line of lines) {
      this.room(size + 3);
      this.put(line, MARGIN, options);
      this.y -= size + 3;
    }
  }

  rule() {
    this.y -= 4;
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: PAGE.width - MARGIN, y: this.y },
      thickness: 0.7,
      color: LINE,
    });
    this.y -= 8;
  }

  gap(points = 8) {
    this.y -= points;
  }
}

interface Column {
  label: string;
  width: number;
  right?: boolean;
}

/** A table: a bold header row, then each row with wrapped cells. `cells` are already text. */
function table(sheet: Sheet, columns: Column[], rows: string[][]) {
  const size = 9;
  const pad = 4;
  const header = () => {
    sheet.room(24);
    let x = MARGIN;
    for (const column of columns) {
      sheet.put(column.label, column.right ? x + column.width - pad : x + pad, {
        size,
        bold: true,
        right: column.right ?? false,
      });
      x += column.width;
    }
    sheet.y -= size + 4;
    sheet.rule();
  };
  header();
  for (const row of rows) {
    const wrapped = row.map((cell, index) =>
      sheet.wrap(cell, columns[index]!.width - 2 * pad, size),
    );
    const lines = Math.max(...wrapped.map((cell) => cell.length));
    const height = lines * (size + 3);
    if (sheet.y - height < MARGIN + 20) {
      sheet.room(height + 20);
      header();
    }
    let x = MARGIN;
    wrapped.forEach((cell, index) => {
      const column = columns[index]!;
      const top = sheet.y;
      cell.forEach((text, lineIndex) => {
        sheet.y = top - lineIndex * (size + 3);
        sheet.put(text, column.right ? x + column.width - pad : x + pad, {
          size,
          right: column.right ?? false,
        });
      });
      sheet.y = top;
      x += column.width;
    });
    sheet.y -= height + 2;
  }
  sheet.rule();
}

/** A label and an amount on one line, the amount on the right edge. */
function totalLine(sheet: Sheet, label: string, paise: number, bold = false) {
  sheet.room(16);
  sheet.put(label, PAGE.width - MARGIN - 130, { bold, right: true });
  sheet.put(rs(paise), PAGE.width - MARGIN, { bold, right: true });
  sheet.y -= 14;
}

async function company() {
  const profile = await CompanyModel.findOne();
  if (!profile) {
    throw conflict(
      'Add the company details first (Masters, Company): they print at the top of every document.',
      'NO_COMPANY',
    );
  }
  return profile;
}

/** The header block both documents share: TriFid on the left, the document name and number on the right. */
function header(
  sheet: Sheet,
  profile: { name: string; address: string; gstin: string },
  title: string,
  number: string,
  date: string,
) {
  sheet.put(profile.name, MARGIN, { size: 15, bold: true });
  sheet.put(title, PAGE.width - MARGIN, { size: 15, bold: true, right: true });
  sheet.y -= 20;
  sheet.put(`GSTIN: ${profile.gstin}`, MARGIN, { size: 9, grey: true });
  sheet.put(`${number}  ·  ${date}`, PAGE.width - MARGIN, { size: 10, right: true });
  sheet.y -= 14;
  sheet.paragraph(profile.address, { size: 9, grey: true, width: 300 });
  sheet.rule();
}

/** The proforma for a sales order. Buyer side only. */
export async function proformaPdf(order: SalesOrderDoc): Promise<Uint8Array> {
  const profile = await company();
  const sheet = await Sheet.create(`Proforma ${order.number}`);
  header(sheet, profile, 'PROFORMA INVOICE', order.number, istDay(order.createdAt));
  sheet.put(
    'Proforma, not a tax invoice. The tax invoice comes from Marg after the goods are checked.',
    MARGIN,
    {
      size: 9,
      bold: true,
    },
  );
  sheet.y -= 18;

  const buyer = order.buyerSnapshot;
  sheet.put('Bill to', MARGIN, { size: 9, grey: true });
  sheet.y -= 12;
  sheet.put(`${buyer.firmName} (${buyer.number})`, MARGIN, { size: 11, bold: true });
  sheet.y -= 15;
  if (buyer.gstin) {
    sheet.put(`GSTIN: ${buyer.gstin}`, MARGIN, { size: 9 });
    sheet.y -= 12;
  }
  sheet.paragraph(`Deliver to: ${buyer.deliveryLocation} (state code ${buyer.stateCode})`, {
    size: 9,
  });
  sheet.gap(6);

  table(
    sheet,
    [
      { label: '#', width: 24 },
      { label: 'Product and pack', width: 175 },
      { label: 'HSN', width: 50 },
      { label: 'Units/box', width: 52, right: true },
      { label: 'Boxes', width: 40, right: true },
      { label: 'Rate/unit', width: 60, right: true },
      { label: 'Box value', width: 62, right: true },
      { label: 'Line total', width: 52, right: true },
    ],
    order.lines.map((line) => [
      String(line.lineNo),
      `${line.productName} · ${line.packLabel}`,
      line.hsnCode,
      String(line.unitsPerBox),
      String(line.boxes),
      rs(line.buyerRatePaisePerUnit),
      rs(line.boxValuePaise),
      rs(line.lineTotalPaise),
    ]),
  );

  // The GST split: rates include tax, so the tax is worked back out of the total.
  const taxBp = order.lines[0]?.taxBp ?? 0;
  totalLine(sheet, 'Taxable value', order.gst.taxablePaise);
  if (order.interState) {
    totalLine(sheet, `IGST ${percent(taxBp)}`, order.gst.igstPaise);
  } else {
    totalLine(sheet, `CGST ${percent(taxBp / 2)}`, order.gst.cgstPaise);
    totalLine(sheet, `SGST ${percent(taxBp / 2)}`, order.gst.sgstPaise);
  }
  totalLine(sheet, 'Total', order.totalPaise, true);
  sheet.gap(10);
  sheet.paragraph(
    `Please pay the full amount by ${istDay(order.paymentDueAt)}. Rates include GST. The order is confirmed once the payment reaches our bank.`,
    { size: 9, grey: true },
  );
  return sheet.doc.save();
}

/** The purchase order for the seller. Seller side only. */
export async function purchaseOrderPdf(po: PurchaseOrderDoc): Promise<Uint8Array> {
  const profile = await company();
  const sheet = await Sheet.create(`Purchase order ${po.number}`);
  header(sheet, profile, 'PURCHASE ORDER', po.number, istDay(po.createdAt));

  const seller = po.sellerSnapshot;
  sheet.put('To', MARGIN, { size: 9, grey: true });
  sheet.y -= 12;
  sheet.put(`${seller.firmName} (${seller.number})`, MARGIN, { size: 11, bold: true });
  sheet.y -= 15;
  if (seller.gstin) {
    sheet.put(`GSTIN: ${seller.gstin}`, MARGIN, { size: 9 });
    sheet.y -= 12;
  }
  sheet.paragraph(
    `Deliver to: ${profile.name}, Indore dock. Please dispatch by ${istDay(po.dispatchDueAt)}.`,
    {
      size: 9,
    },
  );
  sheet.gap(6);

  table(
    sheet,
    [
      { label: '#', width: 24 },
      { label: 'Product and pack', width: 185 },
      { label: 'Units/box', width: 52, right: true },
      { label: 'Boxes', width: 40, right: true },
      { label: 'Expiry', width: 48, right: true },
      { label: 'Rate/unit', width: 70, right: true },
      { label: 'Line total', width: 96, right: true },
    ],
    po.lines.map((line) => [
      String(line.lineNo),
      `${line.productName} · ${line.packLabel}`,
      String(line.unitsPerBox),
      String(line.boxes),
      line.expiryMonth,
      rs(line.landedPaisePerUnit),
      rs(line.lineTotalPaise),
    ]),
  );
  totalLine(sheet, 'Total', po.totalPaise, true);
  sheet.gap(10);
  sheet.paragraph(
    'Rates include GST and delivery to Indore. We pay for the boxes accepted at our dock, against your tax invoice.',
    { size: 9, grey: true },
  );
  return sheet.doc.save();
}
