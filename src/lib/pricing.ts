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
  // Strip thousands grouping separators (e.g. "1,250.00") before parsing so a
  // grouped string doesn't silently become NaN -> ฿0.
  const cleaned = typeof baht === "string" ? baht.replace(/,/g, "").trim() : baht;
  const raw = Number(cleaned);
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
 *  5. proportional allocation (largest-remainder method): per line base alloc =
 *     floor(lineNet/subtotal * billDiscount); distribute the leftover satang
 *     (billDiscount - Σ floor) one at a time to the lines with the largest
 *     fractional remainder (skipping lines already at their lineNet cap), so that
 *     Σ alloc === billDiscount EXACTLY and every alloc stays in [0, lineNet];
 *     lineFinal = lineNet - alloc; lineVat = round(lineFinal * 7 / 107)
 *  6. vat = Σ lineVat
 *
 * Invariant: subtotalSatang - billDiscountSatang === totalSatang.
 * Invariant: Σ alloc === billDiscountSatang (no over/under-allocation, either
 *            rounding direction) and 0 <= alloc[i] <= lineNets[i] for every line.
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

  // 5. proportional allocation of the bill discount across lines via the
  //    largest-remainder method (FIX 2). The previous single-line "push remainder
  //    onto the largest line then clamp(...,0,net)" could break the
  //    Σ alloc === billDiscount invariant: with N equal-net lines + a small-satang
  //    discount the remainder is NEGATIVE and larger than the largest line's
  //    rounded share, so the clamp snapped it to 0 and the discount under-allocated
  //    (overstating extracted VAT by 1-3 satang). Largest-remainder guarantees the
  //    invariant for BOTH rounding directions and keeps every alloc in [0, net].
  const alloc = new Array<number>(lineNets.length).fill(0);
  if (billDiscountSatang > 0 && subtotalSatang > 0) {
    // Base alloc = floor of each line's exact proportional share. Because
    // billDiscount <= subtotal, share = lineNet/subtotal * billDiscount <= lineNet,
    // so floor(share) is always within [0, lineNet]. Track each line's fractional
    // remainder to decide who receives the leftover satang.
    const fractions: { index: number; frac: number }[] = [];
    let allocated = 0;
    for (let i = 0; i < lineNets.length; i++) {
      const exact = (lineNets[i] / subtotalSatang) * billDiscountSatang;
      const base = Math.floor(exact);
      alloc[i] = base;
      allocated += base;
      fractions.push({ index: i, frac: exact - base });
    }
    // Leftover is billDiscount - Σ floor; it is in [0, lineCount) because each
    // floor drops a fraction < 1. Hand it out one satang at a time to the largest
    // fractional remainders first, skipping any line already at its lineNet cap so
    // no alloc ever exceeds its line's net (preserves 0 <= alloc[i] <= lineNets[i]).
    // Repeated passes (bounded by leftover) cover the rare case where the top
    // fractional lines are already capped; since base = floor(share <= lineNet),
    // an eligible line always exists while leftover > 0, so the loop terminates and
    // the Σ alloc === billDiscount invariant holds.
    let leftover = billDiscountSatang - allocated;
    fractions.sort((a, b) => b.frac - a.frac);
    while (leftover > 0) {
      let placedThisPass = false;
      for (const { index } of fractions) {
        if (leftover === 0) break;
        if (alloc[index] < lineNets[index]) {
          alloc[index] += 1;
          leftover -= 1;
          placedThisPass = true;
        }
      }
      // Safety valve: if a full pass placed nothing (all eligible lines capped),
      // stop rather than spin. Unreachable given the floor invariant above.
      if (!placedThisPass) break;
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

// ---------------------------------------------------------------------------
// Server-callable order recompute (Financial/Inventory correctness, Sub-phase A)
// ---------------------------------------------------------------------------

/**
 * A product row as fetched from the DB for server-authoritative recompute.
 * `price` is the catalog unit price in baht — accepted as a Prisma Decimal
 * (`.toString()`-able object), a numeric string, or a number. It is converted to
 * integer satang via `bahtToSatang` so the server never trusts a client price.
 */
export type OrderProductRow = {
  id: string;
  /** Catalog unit price in baht. Prisma Decimal | numeric string | number. */
  price: { toString(): string } | string | number;
};

/**
 * One requested line in a checkout. The server trusts ONLY `productId`,
 * `quantity`, and the optional per-line discount — never any client-sent money.
 */
export type OrderRequestLine = {
  productId: string;
  quantity: number;
  /**
   * Optional per-line discount in **integer satang** (the cart's "ส่วนลดรายการ"
   * feature). Clamped server-side to [0, line gross]. Omitted/non-finite = 0.
   */
  lineDiscountSatang?: number;
};

/** Per-line server-recomputed result (integer satang). */
export type OrderLineResult = {
  productId: string;
  quantity: number;
  /** Catalog unit price in satang (from the DB, not the client). */
  priceSatang: number;
  /**
   * Line total in satang AFTER the per-line discount but BEFORE the bill-level
   * proportional allocation — i.e. `max(price*qty - lineDiscount, 0)`. This is the
   * value stored as OrderItem.lineTotal so Σ lineTotal === Order.subtotal.
   */
  lineTotalSatang: number;
};

/** Full server-recomputed order money result (all integer satang). */
export type OrderTotals = {
  /** Σ of each line's (price*qty - lineDiscount), before the bill discount. */
  subtotalSatang: number;
  /** Bill-level discount actually applied, clamped to the subtotal. */
  billDiscountSatang: number;
  /** Σ of per-line inclusive VAT after the bill-discount allocation. */
  vatSatang: number;
  /** subtotal - billDiscount. Invariant: subtotal - billDiscount === total. */
  totalSatang: number;
  /** Per-line breakdown (same order as the requested items). */
  lines: OrderLineResult[];
};

/** Thrown when a requested productId is not present in the fetched product rows. */
export class OrderProductMissingError extends Error {
  constructor(public readonly productId: string) {
    super(`Product not found: ${productId}`);
    this.name = "OrderProductMissingError";
  }
}

/**
 * Server-authoritative order recompute in integer satang.
 *
 * The server NEVER trusts client-sent subtotal/tax/discount/total. It recomputes
 * everything from the DB product prices + the requested quantities + the
 * bill-level discount (and the optional per-line discount, which mirrors the
 * cart's existing "ส่วนลดรายการ" feature). Internally it delegates to the same
 * `computeTotals()` engine the client uses, so server and client totals match
 * exactly (same proportional-allocation + inclusive-VAT rounding).
 *
 * @throws {OrderProductMissingError} if any requested productId is absent.
 * @throws {RangeError} if `discountValue` is negative, or (for percent) > 100.
 */
export function computeOrderTotals(
  products: OrderProductRow[],
  requested: OrderRequestLine[],
  bill: BillDiscount
): OrderTotals {
  // Validate the bill discount (server boundary — the client also gates this, but
  // the server is authoritative). value must be >= 0; percent additionally <= 100.
  if (!Number.isFinite(bill.value) || bill.value < 0) {
    throw new RangeError("discountValue must be a finite number >= 0");
  }
  if (bill.type === "percent" && bill.value > 100) {
    throw new RangeError("percent discountValue must be <= 100");
  }

  // Index products by id for O(1) lookup; missing ids are a hard error. A Prisma
  // Decimal is an object with a precise `toString()`, so normalize any object
  // price to its string form before the satang conversion (numbers/strings pass
  // through unchanged).
  const priceById = new Map<string, number>();
  for (const p of products) {
    const priceInput: number | string =
      typeof p.price === "object" && p.price !== null
        ? p.price.toString()
        : (p.price as number | string);
    priceById.set(p.id, bahtToSatang(priceInput));
  }

  // Build the PricingItem[] in the SAME order as the requested lines, carrying the
  // DB price (never the client price) and the clamped per-line discount.
  const pricingItems: PricingItem[] = requested.map((line) => {
    const priceSatang = priceById.get(line.productId);
    if (priceSatang === undefined) {
      throw new OrderProductMissingError(line.productId);
    }
    const qty = Math.max(Math.trunc(Number(line.quantity)), 0);
    const gross = Math.max(priceSatang, 0) * qty;
    const requestedLineDiscount = Number.isFinite(line.lineDiscountSatang)
      ? Math.max(Math.trunc(line.lineDiscountSatang as number), 0)
      : 0;
    // Per-line discount can never exceed the line gross (mirrors the client clamp).
    const lineDiscountSatang = Math.min(requestedLineDiscount, gross);
    return { priceSatang, qty, lineDiscountSatang };
  });

  const totals = computeTotals(pricingItems, bill);

  const lines: OrderLineResult[] = requested.map((line, i) => {
    const priceSatang = priceById.get(line.productId) as number;
    const qty = pricingItems[i].qty;
    const lineDiscount = pricingItems[i].lineDiscountSatang ?? 0;
    // lineTotal stored = (price*qty - lineDiscount), floored at 0. Σ lineTotal
    // === subtotalSatang (the bill discount is a separate header field, allocated
    // proportionally only for VAT extraction — it is NOT folded into lineTotal).
    const lineTotalSatang = Math.max(Math.max(priceSatang, 0) * qty - lineDiscount, 0);
    return { productId: line.productId, quantity: qty, priceSatang, lineTotalSatang };
  });

  return {
    subtotalSatang: totals.subtotalSatang,
    billDiscountSatang: totals.billDiscountSatang,
    vatSatang: totals.vatSatang,
    totalSatang: totals.totalSatang,
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
