/**
 * Pure pricing math for the POS cart — Phase 2.
 *
 * Everything here is computed in **integer satang** (1 baht = 100 satang) to
 * avoid IEEE-754 float drift on money. Never do float arithmetic on baht for
 * totals: convert baht -> satang ONCE at the boundary
 * (`Math.round(Number(price) * 100)`), do all math as integers, then format the
 * resulting satang back to baht via `money(satang / 100)` (see ./money).
 *
 * VAT is treated as **inclusive** (Thai 7% VAT baked into the displayed price):
 * the VAT component is extracted from the price as `amount * 7 / 107`, never
 * added on top.
 *
 * A bill-level discount is allocated **proportionally** across lines (by each
 * line's net contribution to the subtotal) so per-line VAT sums exactly to the
 * bill VAT. Allocation rounding remainder is added to the largest line so the
 * invariant `Σ alloc === billDiscountSatang` always holds.
 *
 * Production-readiness note: full end-to-end Decimal money is owned by the
 * sibling production-readiness program; integer satang keeps Phase 2 exact in
 * the meantime and is structured so it can be swapped for Decimal later.
 */

/** VAT rate numerator/denominator for 7% inclusive extraction (amount * 7 / 107). */
const VAT_NUM = 7;
const VAT_DEN = 107;

export type PricingItem = {
  /** Unit price in satang (integer). */
  priceSatang: number;
  /** Quantity (integer >= 1). */
  qty: number;
  /** Optional per-line discount in satang (integer >= 0). */
  lineDiscountSatang?: number;
};

export type BillDiscount = {
  /** "amount" = a flat baht discount; "percent" = a percentage of the subtotal. */
  type: "amount" | "percent";
  /** For "amount": baht. For "percent": a percentage 0..100. */
  value: number;
};

export type LineTotal = {
  /** Net of this line after the bill-discount allocation, in satang. */
  netSatang: number;
  /** Inclusive VAT extracted from this line's final amount, in satang. */
  vatSatang: number;
};

export type Totals = {
  /** Σ of each line's gross-minus-line-discount, before the bill discount (satang). */
  subtotalSatang: number;
  /** Bill-level discount actually applied, clamped to the subtotal (satang). */
  billDiscountSatang: number;
  /** subtotal - billDiscount (satang). Invariant: subtotal - billDiscount === total. */
  totalSatang: number;
  /** Σ of per-line inclusive VAT (satang). */
  vatSatang: number;
  /** Per-line breakdown after proportional allocation (same order as input). */
  lines: LineTotal[];
};

/** Round half-up to an integer (satang are integers). Guards non-finite input. */
function roundSatang(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

/** Clamp a value into the inclusive range [min, max]. */
function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/** Convert a baht amount (number or numeric string) to integer satang. */
export function bahtToSatang(baht: number | string): number {
  const raw = typeof baht === "string" ? Number(baht.trim()) : baht;
  if (!Number.isFinite(raw)) return 0;
  return Math.round(raw * 100);
}

/**
 * Compute cart totals in integer satang.
 *
 * Algorithm (all integer satang):
 *  1. per line: lineNet = max(priceSatang*qty - (lineDiscountSatang||0), 0)
 *  2. subtotal = Σ lineNet
 *  3. billDiscount = amount ? min(round(value*100), subtotal)
 *                           : round(subtotal * clamp(value,0,100) / 100)
 *  4. total = subtotal - billDiscount
 *  5. proportional allocation: per line alloc = round(lineNet/subtotal * billDiscount);
 *     fix rounding so Σ alloc === billDiscount (remainder to the largest line);
 *     lineFinal = lineNet - alloc; lineVat = round(lineFinal * 7 / 107)
 *  6. vat = Σ lineVat
 *
 * Invariant: subtotalSatang - billDiscountSatang === totalSatang.
 */
export function computeTotals(items: PricingItem[], bill: BillDiscount): Totals {
  // 1. per-line net (gross minus per-line discount, floored at 0).
  const lineNets = items.map((it) => {
    const qty = Number.isFinite(it.qty) ? Math.max(Math.trunc(it.qty), 0) : 0;
    const gross = Math.max(roundSatang(it.priceSatang), 0) * qty;
    const lineDiscount = Math.max(roundSatang(it.lineDiscountSatang ?? 0), 0);
    return Math.max(gross - lineDiscount, 0);
  });

  // 2. subtotal.
  const subtotalSatang = lineNets.reduce((s, n) => s + n, 0);

  // 3. bill discount, clamped to the subtotal.
  let billDiscountSatang: number;
  if (bill.type === "amount") {
    billDiscountSatang = Math.min(
      Math.max(roundSatang(bill.value * 100), 0),
      subtotalSatang
    );
  } else {
    const pct = clamp(Number.isFinite(bill.value) ? bill.value : 0, 0, 100);
    billDiscountSatang = roundSatang((subtotalSatang * pct) / 100);
    // Defensive: rounding can never exceed the subtotal, but clamp anyway.
    billDiscountSatang = Math.min(billDiscountSatang, subtotalSatang);
  }

  // 4. total.
  const totalSatang = subtotalSatang - billDiscountSatang;

  // 5. proportional allocation of the bill discount across lines.
  const alloc = new Array<number>(lineNets.length).fill(0);
  if (billDiscountSatang > 0 && subtotalSatang > 0) {
    let allocated = 0;
    for (let i = 0; i < lineNets.length; i++) {
      const a = roundSatang((lineNets[i] / subtotalSatang) * billDiscountSatang);
      alloc[i] = a;
      allocated += a;
    }
    // Fix rounding drift so Σ alloc === billDiscountSatang: push the remainder
    // (positive or negative) onto the largest line, which best absorbs it.
    let remainder = billDiscountSatang - allocated;
    if (remainder !== 0 && lineNets.length > 0) {
      let largest = 0;
      for (let i = 1; i < lineNets.length; i++) {
        if (lineNets[i] > lineNets[largest]) largest = i;
      }
      alloc[largest] += remainder;
      // Never let a line's allocation exceed its own net or go negative.
      alloc[largest] = clamp(alloc[largest], 0, lineNets[largest]);
    }
  }

  // 6. per-line final + inclusive VAT.
  const lines: LineTotal[] = lineNets.map((net, i) => {
    const lineFinal = Math.max(net - alloc[i], 0);
    const vatSatang = roundSatang((lineFinal * VAT_NUM) / VAT_DEN);
    return { netSatang: lineFinal, vatSatang };
  });

  const vatSatang = lines.reduce((s, l) => s + l.vatSatang, 0);

  return {
    subtotalSatang,
    billDiscountSatang,
    totalSatang,
    vatSatang,
    lines,
  };
}

/**
 * Sum a set of split-payment line amounts in **integer satang**.
 *
 * Each input is a baht amount (number or numeric string as typed in the UI);
 * non-finite/blank entries contribute 0. Summing in satang keeps the split total
 * float-drift-free so it can be compared exactly against the bill total.
 */
export function sumPaySatang(amountsBaht: Array<number | string>): number {
  return amountsBaht.reduce<number>((acc, baht) => acc + bahtToSatang(baht), 0);
}

/**
 * Remaining unpaid amount in **integer satang**, floored at 0.
 *
 * `remaining = max(totalSatang - Σ paid, 0)`. Used to prefill a newly-added
 * split line with the still-owed amount.
 */
export function remainingPaySatang(
  totalSatang: number,
  amountsBaht: Array<number | string>
): number {
  const total = Number.isFinite(totalSatang) ? Math.max(totalSatang, 0) : 0;
  return Math.max(total - sumPaySatang(amountsBaht), 0);
}
