"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ScanBarcode, ShoppingCart, UserRound, AlertCircle, ChevronRight } from "lucide-react";
import type {
  Product,
  CartItem,
  CategorySlug,
  CustomerDTO,
  DiscountType,
  PayLine,
  PayMethod,
  OrderDTO,
} from "@/types";
import { useToast } from "@/components/ToastProvider";
import {
  bahtToSatang,
  computeTotals,
  remainingPaySatang,
  type PricingItem,
} from "@/lib/pricing";
import { slugForCategoryName } from "@/components/pos/categoryMeta";
import { CategoryPanel, type CategoryChip } from "@/components/pos/CategoryPanel";
import { ProductCard } from "@/components/pos/ProductCard";
import { CartLine } from "@/components/pos/CartLine";
import { TotalsBar } from "@/components/pos/TotalsBar";
import { PaymentModal } from "@/components/pos/PaymentModal";
import { CustomerPickerModal } from "@/components/pos/CustomerPickerModal";
import { ReceiptModal } from "@/components/pos/ReceiptModal";
import { methodToEnum } from "@/components/pos/paymentMeta";

/**
 * Default stock fallback (domain-stock-default-50): the schema always carries
 * an Int stock, but if the API payload omits it (null/undefined) we default to
 * 50 defensively so a product never renders with an undefined count.
 */
const DEFAULT_STOCK = 50;

/** Resolve a product's effective stock with the defensive default. */
function effectiveStock(p: Product): number {
  return typeof p.stock === "number" && Number.isFinite(p.stock)
    ? p.stock
    : DEFAULT_STOCK;
}

// Monotonic counter for stable PayLine ids. A simple counter (rather than
// crypto.randomUUID) keeps ids deterministic, dependency-free, and SSR-safe.
let payLineSeq = 0;
function nextPayLineId(): string {
  payLineSeq += 1;
  return `pl-${payLineSeq}`;
}

/** Chip order for the category panel (slug -> position). */
const CHIP_ORDER: CategorySlug[] = ["all", "drink", "food", "dessert", "goods", "other"];

type LoadState = "loading" | "ready" | "error";

export default function POSPage() {
  const { showToast } = useToast();

  const [products, setProducts] = useState<Product[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");

  const [cart, setCart] = useState<CartItem[]>([]);
  const [search, setSearch] = useState("");
  const [activeCat, setActiveCat] = useState<CategorySlug>("all");

  // Bill discount: text draft + ฿/% mode.
  const [discountDraft, setDiscountDraft] = useState("");
  const [discountType, setDiscountType] = useState<DiscountType>("amount");

  // ---- customer + tax-invoice state (Phase 6a) ----
  // Selected customer (null = walk-in / ลูกค้าทั่วไป) and whether a tax invoice
  // was requested. customerHasTax drives the blue "มีข้อมูลภาษี" badge + the
  // checkout tax gate (domain-tax-invoice-requires-tax-customer).
  const [customer, setCustomer] = useState<CustomerDTO | null>(null);
  const [taxRequested, setTaxRequested] = useState(false);
  const [custPickerOpen, setCustPickerOpen] = useState(false);

  // ---- payment modal state (owned here so closePayment can preserve payLines) ----
  const [payOpen, setPayOpen] = useState(false);
  const [payLines, setPayLines] = useState<PayLine[]>([]);
  const [cashReceived, setCashReceived] = useState("");
  const [reference, setReference] = useState("");
  const [payError, setPayError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // ---- receipt modal state ----
  const [receiptOrder, setReceiptOrder] = useState<OrderDTO | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);

  // Fetch products (DB-dependent) with graceful loading/empty/error states.
  useEffect(() => {
    const ctrl = new AbortController();
    setLoadState("loading");
    fetch("/api/products", { signal: ctrl.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: Product[]) => {
        if (ctrl.signal.aborted) return;
        setProducts(Array.isArray(data) ? data : []);
        setLoadState("ready");
      })
      .catch((err) => {
        if (err?.name === "AbortError" || ctrl.signal.aborted) return;
        setLoadState("error");
      });
    return () => ctrl.abort();
  }, []);

  // Category chips derived from fetched products (+ synthetic all-chip).
  const chips: CategoryChip[] = useMemo(() => {
    const bySlug = new Map<CategorySlug, string>();
    for (const p of products) {
      const slug = slugForCategoryName(p.category?.name);
      if (!bySlug.has(slug)) {
        bySlug.set(slug, p.category?.name ?? "อื่นๆ");
      }
    }
    const result: CategoryChip[] = [{ slug: "all", label: "ทั้งหมด" }];
    for (const slug of CHIP_ORDER) {
      if (slug === "all") continue;
      if (bySlug.has(slug)) {
        result.push({ slug, label: bySlug.get(slug)! });
      }
    }
    return result;
  }, [products]);

  // If the active category disappears (e.g. after a reload), fall back to all.
  useEffect(() => {
    if (activeCat !== "all" && !chips.some((c) => c.slug === activeCat)) {
      setActiveCat("all");
    }
  }, [chips, activeCat]);

  // Filter: category + case-insensitive search across name + sku + category name.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      const slug = slugForCategoryName(p.category?.name);
      const catOk = activeCat === "all" || slug === activeCat;
      if (!catOk) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        (p.category?.name ?? "").toLowerCase().includes(q)
      );
    });
  }, [products, search, activeCat]);

  // Cart qty lookup for the in-cart badge.
  const cartQtyById = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of cart) m.set(i.product.id, i.quantity);
    return m;
  }, [cart]);

  // Totals via the pure integer-satang engine.
  const totals = useMemo(() => {
    const items: PricingItem[] = cart.map((i) => ({
      priceSatang: bahtToSatang(i.product.price),
      qty: i.quantity,
      lineDiscountSatang: i.lineDiscountSatang,
    }));
    const value = Number(discountDraft.trim());
    const bill = {
      type: discountType,
      value: Number.isFinite(value) ? value : 0,
    };
    return computeTotals(items, bill);
  }, [cart, discountDraft, discountType]);

  // ---- cart actions ----
  function addToCart(product: Product) {
    if (effectiveStock(product) === 0) return;
    setCart((prev) => {
      const existing = prev.find((i) => i.product.id === product.id);
      if (existing) {
        return prev.map((i) =>
          i.product.id === product.id ? { ...i, quantity: i.quantity + 1 } : i
        );
      }
      return [...prev, { product, quantity: 1, lineDiscountSatang: 0 }];
    });
    showToast(`เพิ่ม ${product.name} แล้ว`);
  }

  function incLine(productId: string) {
    setCart((prev) =>
      prev.map((i) =>
        i.product.id === productId ? { ...i, quantity: i.quantity + 1 } : i
      )
    );
  }

  function decLine(productId: string) {
    setCart((prev) =>
      prev
        .map((i) =>
          i.product.id === productId ? { ...i, quantity: i.quantity - 1 } : i
        )
        .filter((i) => i.quantity > 0)
        // Re-clamp the per-line discount if the line shrank below it.
        .map((i) => {
          const gross = bahtToSatang(i.product.price) * i.quantity;
          return i.lineDiscountSatang > gross
            ? { ...i, lineDiscountSatang: gross }
            : i;
        })
    );
  }

  function removeLine(productId: string) {
    setCart((prev) => prev.filter((i) => i.product.id !== productId));
  }

  function setLineDiscount(productId: string, discountSatang: number) {
    setCart((prev) =>
      prev.map((i) =>
        i.product.id === productId
          ? { ...i, lineDiscountSatang: Math.max(discountSatang, 0) }
          : i
      )
    );
  }

  /** Clear the cart back to a blank bill (shared by cancel + hold + new-sale). */
  // Also resets the customer + tax-invoice selection so a new bill starts as a
  // walk-in (matches Simple POS: cancel/hold/new-sale clear `customer`).
  function clearBill() {
    setCart([]);
    setDiscountDraft("");
    setDiscountType("amount");
    setCustomer(null);
    setTaxRequested(false);
  }

  // ---- customer picker (Phase 6a) ----
  // Whether the selected customer has a usable tax id (state-customer-has-tax).
  const customerHasTax =
    customer != null &&
    typeof customer.taxId === "string" &&
    customer.taxId.trim().length > 0;

  function pickCustomer(c: CustomerDTO) {
    setCustomer(c);
    // A customer without a usable taxId can't request a tax invoice; drop any
    // stale tax flag (and clear the related payError) so checkout doesn't 422 —
    // mirrors the pickWalkIn guard.
    if (!c.taxId?.trim()) {
      setTaxRequested(false);
      setPayError("");
    }
    setCustPickerOpen(false);
  }

  // Walk-in clears the selected customer; a walk-in can't request a tax invoice,
  // so the tax flag is dropped too.
  function pickWalkIn() {
    setCustomer(null);
    setTaxRequested(false);
    setCustPickerOpen(false);
  }

  function toggleTax() {
    setTaxRequested((v) => !v);
    setPayError("");
  }

  // cancel-vs-hold-difference: both clear the cart, but carry a different
  // intent/toast. Cancel = abandon the sale; hold = park it for later.
  function cancelBill() {
    if (cart.length === 0) return;
    clearBill();
    showToast("ยกเลิกบิลแล้ว");
  }

  function holdBill() {
    if (cart.length === 0) {
      showToast("ตะกร้าว่าง ไม่สามารถพักบิลได้");
      return;
    }
    clearBill();
    showToast("พักบิลไว้แล้ว");
  }

  // Enter on an exact SKU match = scan-to-cart.
  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    const q = search.trim().toLowerCase();
    if (!q) return;
    const match = products.find((p) => p.sku.toLowerCase() === q);
    if (match) {
      addToCart(match);
      setSearch("");
    }
  }

  // ---- payment modal (Phase 3) ----

  // Open payment. If an in-progress split was preserved (closed via X), reuse it;
  // otherwise seed a single cash line = total (action-open-payment). This keeps
  // the documented "X preserves payLines" behavior from being defeated by a reset
  // on re-open. cashReceived/reference are likewise only cleared when seeding a
  // fresh split, so a preserved split keeps its full state on re-open. (The
  // success-confirm path is the one that fully resets all payment state.)
  function openPayment() {
    if (cart.length === 0) {
      showToast("ตะกร้าว่าง · Cart is empty");
      return;
    }
    if (payLines.length === 0) {
      // Fresh split: seed a single cash line = total and clear any stale
      // cash-received / reference.
      const totalBaht = (totals.totalSatang / 100).toFixed(2);
      setPayLines([{ id: nextPayLineId(), method: "cash", amount: totalBaht }]);
      setCashReceived("");
      setReference("");
    }
    // else: a preserved split exists (closed via X) — leave payLines/cash/ref intact.
    setPayError("");
    setPayOpen(true);
  }

  // Close (X): mark closed but PRESERVE payLines/cash/reference for re-open.
  function closePayment() {
    setPayOpen(false);
  }

  // Select a method: applies to the LAST payment line — the one just added via
  // "Split payment" / currently being configured. In single-line mode that is
  // simply the one line. This is coherent with the add-line UX (the newest line
  // is the active target) and replaces the previously dead `locked` mechanism.
  function setPayMethod(method: PayMethod) {
    setPayLines((prev) => {
      if (prev.length === 0) {
        return [{ id: nextPayLineId(), method, amount: "0.00" }];
      }
      const next = [...prev];
      const target = next.length - 1;
      next[target] = { ...next[target], method };
      return next;
    });
    setPayError("");
  }

  function setPayAmount(index: number, value: string) {
    setPayLines((prev) =>
      prev.map((l, i) => (i === index ? { ...l, amount: value } : l))
    );
    setPayError("");
  }

  // Add a split line prefilled with the remaining unpaid amount.
  function addPayLine() {
    setPayLines((prev) => {
      const remaining = remainingPaySatang(
        totals.totalSatang,
        prev.map((l) => l.amount)
      );
      return [
        ...prev,
        {
          id: nextPayLineId(),
          method: "transfer",
          amount: (remaining / 100).toFixed(2),
        },
      ];
    });
    setPayError("");
  }

  // Remove a split line by stable id (guarded to keep at least one).
  function removePayLine(id: string) {
    setPayLines((prev) =>
      prev.length > 1 ? prev.filter((l) => l.id !== id) : prev
    );
    setPayError("");
  }

  function onCashReceived(value: string) {
    setCashReceived(value);
    setPayError("");
  }

  function onSetReference(value: string) {
    setReference(value);
  }

  // Confirm → validate, POST /api/orders, open the receipt on success.
  async function confirmPayment() {
    if (submitting || cart.length === 0) return;

    // Phase 6a tax gate (client mirror of the server rule
    // domain-tax-invoice-requires-tax-customer): a tax invoice requires a
    // selected customer that has a tax id.
    if (taxRequested && (!customer || !customerHasTax)) {
      setPayError(
        "ต้องเลือกลูกค้าที่มีเลขผู้เสียภาษีก่อนออกใบกำกับภาษี"
      );
      return;
    }

    const totalSatang = totals.totalSatang;
    const paidSatang = payLines.reduce(
      (acc, l) => acc + bahtToSatang(l.amount),
      0
    );
    // Split sum must equal the total within 0.01 baht (1 satang).
    if (Math.abs(paidSatang - totalSatang) > 1) {
      setPayError(
        `ยอดชำระ (${(paidSatang / 100).toFixed(2)}) ไม่ตรงกับยอดที่ต้องจ่าย (${(
          totalSatang / 100
        ).toFixed(2)})`
      );
      return;
    }
    // Cash due = sum of ALL cash lines (a split may carry more than one cash
    // line); cash received must cover that cash portion (not the full bill — the
    // split-sum check above already proves the bill is fully covered).
    const cashLines = payLines.filter((l) => l.method === "cash");
    const hasCash = cashLines.length > 0;
    const cashDueSatang = cashLines.reduce(
      (acc, l) => acc + bahtToSatang(l.amount),
      0
    );
    const receivedSatang = bahtToSatang(cashReceived);
    if (hasCash && receivedSatang + 1 < cashDueSatang) {
      setPayError("รับเงินสดน้อยกว่ายอดเงินสดที่ต้องจ่าย");
      return;
    }

    // Change = max(cash received − cash due, 0).
    const changeSatang = hasCash
      ? Math.max(receivedSatang - cashDueSatang, 0)
      : 0;
    // amountPaid = total tendered, so amountPaid − change === total for splits:
    // (sum of non-cash line amounts) + (cash received). Pure-cash reduces to the
    // cash received; pure-non-cash reduces to the split total.
    const nonCashSatang = payLines
      .filter((l) => l.method !== "cash")
      .reduce((acc, l) => acc + bahtToSatang(l.amount), 0);
    const amountPaidSatang = hasCash
      ? nonCashSatang + receivedSatang
      : paidSatang;

    setSubmitting(true);
    setPayError("");
    try {
      const trimmedRef = reference.trim();
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: cart.map((i) => ({
            productId: i.product.id,
            quantity: i.quantity,
          })),
          paymentLines: payLines.map((l) => ({
            method: methodToEnum(l.method),
            amount: bahtToSatang(l.amount) / 100,
            reference: trimmedRef.length > 0 ? trimmedRef : null,
          })),
          subtotal: totals.subtotalSatang / 100,
          discount: totals.billDiscountSatang / 100,
          tax: totals.vatSatang / 100,
          total: totalSatang / 100,
          amountPaid: amountPaidSatang / 100,
          change: changeSatang / 100,
          customerId: customer?.id ?? null,
          taxRequested,
        }),
      });
      if (!res.ok) {
        let msg = "ชำระเงินไม่สำเร็จ ลองใหม่อีกครั้ง";
        try {
          const data = await res.json();
          if (data?.error) msg = data.error;
        } catch {
          /* keep default message */
        }
        setPayError(msg);
        return;
      }
      const order = (await res.json()) as OrderDTO;
      // Success: open the receipt, clear the cart + payment state.
      setReceiptOrder(order);
      setReceiptOpen(true);
      setPayOpen(false);
      setPayLines([]);
      setCashReceived("");
      setReference("");
      setPayError("");
      clearBill();
    } catch {
      setPayError("ชำระเงินไม่สำเร็จ ลองใหม่อีกครั้ง");
    } finally {
      setSubmitting(false);
    }
  }

  // ---- receipt actions ----
  function printReceipt() {
    showToast("กำลังเปิดหน้าต่างพิมพ์ใบเสร็จ");
    setTimeout(() => {
      try {
        window.print();
      } catch {
        /* printing unavailable in this environment */
      }
    }, 120);
  }

  function emailReceipt() {
    showToast("ส่งลิงก์ใบเสร็จให้ลูกค้าแล้ว");
  }

  // New sale — the ONLY way to dismiss the receipt.
  function newSale() {
    setReceiptOpen(false);
    setReceiptOrder(null);
  }

  // Total item count (physical pieces) for the payment summary.
  const itemCount = useMemo(
    () => cart.reduce((acc, i) => acc + i.quantity, 0),
    [cart]
  );

  const productTitle =
    activeCat === "all"
      ? "สินค้าทั้งหมด"
      : chips.find((c) => c.slug === activeCat)?.label ?? "สินค้า";

  return (
    <div
      className="flex h-full min-h-0"
      style={{
        background:
          "radial-gradient(circle at 35% -15%,rgba(31,169,113,.18),transparent 35%),var(--bg)",
      }}
    >
      {/* Workspace: header + command + category panel + product grid.
          A <div> (not <main>) — the (shell) layout already provides the single
          <main> landmark, so exactly one main exists per page (a11y). */}
      <div className="flex min-w-0 flex-1 flex-col gap-3.5 p-[18px] pl-5">
        <header className="flex h-[68px] items-center gap-3.5">
          <div className="flex-1">
            <h1 className="m-0 text-[24px] font-bold leading-[1.08] tracking-tight">
              ขายหน้าร้าน
            </h1>
            <p className="mt-1 text-[12.5px]" style={{ color: "var(--muted)" }}>
              POS Checkout · เลือกสินค้า, ปรับส่วนลด, ปิดการขาย
            </p>
          </div>
        </header>

        {/* Search / scan */}
        <section>
          <label
            className="flex h-[58px] items-center gap-[11px] rounded-[18px] border bg-white px-4"
            style={{ borderColor: "var(--line)", boxShadow: "var(--shadow-sm)" }}
          >
            <span className="sr-only">ค้นหาสินค้า หรือสแกนบาร์โค้ด</span>
            <ScanBarcode size={20} strokeWidth={2} color="#667085" />
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="สแกนบาร์โค้ด หรือค้นหาสินค้า เช่น ลาเต้ / BV-002"
              autoComplete="off"
              aria-label="ค้นหาสินค้า หรือสแกนบาร์โค้ด"
              className="min-w-0 flex-1 border-0 text-[15px] font-medium outline-none"
              style={{ color: "var(--ink)" }}
            />
          </label>
        </section>

        {/* Category panel + product grid. The column template lives in the
            `.pos-grid` CSS class so a `@media (max-width: 900px)` rule can narrow
            the 168px category column on tablet without an inline style winning. */}
        <section className="pos-grid grid min-h-0 flex-1">
          <CategoryPanel chips={chips} active={activeCat} onSelect={setActiveCat} />

          <section className="min-w-0 overflow-auto pr-1">
            <div className="mb-2.5 flex h-9 items-center justify-between px-0.5">
              <strong className="text-[13px]">{productTitle}</strong>
              <span className="text-[12px]" style={{ color: "var(--muted)" }}>
                {filtered.length} รายการ
              </span>
            </div>

            {loadState === "loading" ? (
              <div
                className="grid place-items-center py-16 text-center text-[13px]"
                style={{ color: "var(--soft)" }}
              >
                กำลังโหลดสินค้า…
              </div>
            ) : loadState === "error" ? (
              <div
                className="mx-auto flex max-w-[320px] flex-col items-center gap-3 py-16 text-center"
                style={{ color: "var(--muted)" }}
              >
                <span
                  className="grid h-[70px] w-[70px] place-items-center rounded-[24px]"
                  style={{ background: "#fff1f1", color: "#dc2626" }}
                >
                  <AlertCircle size={30} strokeWidth={2} />
                </span>
                <strong className="text-[14px]" style={{ color: "var(--ink)" }}>
                  โหลดสินค้าไม่สำเร็จ
                </strong>
                <p className="m-0 text-[12px] leading-relaxed">
                  ตรวจสอบการเชื่อมต่อฐานข้อมูล แล้วลองรีเฟรชอีกครั้ง
                </p>
              </div>
            ) : filtered.length === 0 ? (
              <div
                className="grid place-items-center py-16 text-center text-[13px]"
                style={{ color: "var(--soft)" }}
              >
                ไม่พบสินค้า · No matching products
              </div>
            ) : (
              <div
                className="grid gap-3"
                style={{ gridTemplateColumns: "repeat(auto-fill,minmax(184px,1fr))" }}
              >
                {filtered.map((p) => (
                  <ProductCard
                    key={p.id}
                    product={p}
                    stock={effectiveStock(p)}
                    inCartQty={cartQtyById.get(p.id) ?? 0}
                    onAdd={addToCart}
                  />
                ))}
              </div>
            )}
          </section>
        </section>
      </div>

      {/* Cart panel — width lives in the `.pos-cart` CSS class (globals.css), not a
          Tailwind `w-[...]` utility, so the `@media (max-width: 900px)` rule can
          narrow it on tablet (408px desktop → 340px tablet). */}
      <aside
        className="pos-cart flex flex-shrink-0 flex-col border-l bg-white"
        style={{
          borderColor: "var(--line)",
          boxShadow: "-16px 0 36px rgba(21,38,64,.06)",
        }}
      >
        <div className="flex items-center gap-3 border-b p-[18px]" style={{ borderColor: "var(--line)" }}>
          <button
            type="button"
            onClick={() => setCustPickerOpen(true)}
            aria-label="เลือกลูกค้า"
            className="flex h-16 flex-1 items-center gap-3 rounded-[18px] border border-dashed px-3.5 text-left transition hover:border-[#16a34a] hover:bg-[#f0fdf4]"
            style={{ borderColor: "var(--line-strong)", background: "#fbfdff" }}
          >
            <span
              className="grid h-[38px] w-[38px] flex-shrink-0 place-items-center rounded-[14px]"
              style={{ background: "#eef4ff", color: "#2563eb" }}
            >
              <UserRound size={18} strokeWidth={2} />
            </span>
            <span className="min-w-0 flex-1">
              <strong className="block truncate text-[13px]">
                {customer ? customer.name : "ลูกค้าทั่วไป · Walk-in"}
              </strong>
              <span className="block truncate text-[11px]" style={{ color: "var(--muted)" }}>
                {customer
                  ? customerHasTax
                    ? `TIN ${customer.taxId}`
                    : "สมาชิก · ไม่มีเลขภาษี"
                  : "แตะเพื่อเลือกลูกค้า"}
              </span>
            </span>
            {customerHasTax && (
              <span
                className="flex-shrink-0 rounded-md px-2 py-[3px] text-[10px] font-semibold"
                style={{
                  background: "#eff6ff",
                  color: "#2563eb",
                  border: "1px solid #bfdbfe",
                }}
              >
                มีข้อมูลภาษี
              </span>
            )}
            <ChevronRight size={16} strokeWidth={2} color="#94a3b8" className="flex-shrink-0" />
          </button>
        </div>

        {/* Cart list */}
        <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-auto p-[18px]">
          {cart.length === 0 ? (
            <div className="grid h-full place-items-center text-center" style={{ color: "var(--soft)" }}>
              <div className="max-w-[220px]">
                <span
                  className="mx-auto mb-3.5 grid h-[70px] w-[70px] place-items-center rounded-[24px]"
                  style={{ background: "#f2f4f7" }}
                >
                  <ShoppingCart size={30} strokeWidth={2} />
                </span>
                <strong>ตะกร้าว่าง</strong>
                <p className="mt-1.5 text-[12px] leading-relaxed">
                  สแกนบาร์โค้ดหรือแตะสินค้าเพื่อเริ่มขาย
                </p>
              </div>
            </div>
          ) : (
            cart.map((item) => (
              <CartLine
                key={item.product.id}
                item={item}
                lineGrossSatang={bahtToSatang(item.product.price) * item.quantity}
                onInc={incLine}
                onDec={decLine}
                onRemove={removeLine}
                onLineDiscount={setLineDiscount}
              />
            ))
          )}
        </div>

        <TotalsBar
          totals={totals}
          discountDraft={discountDraft}
          discountType={discountType}
          onDiscountChange={setDiscountDraft}
          onToggleDiscountType={() =>
            setDiscountType((t) => (t === "amount" ? "percent" : "amount"))
          }
          onHoldBill={holdBill}
          onCancelBill={cancelBill}
          onPay={openPayment}
          payDisabled={cart.length === 0 || submitting}
          checkingOut={submitting}
        />
      </aside>

      {/* Customer picker (Phase 6a) */}
      <CustomerPickerModal
        open={custPickerOpen}
        onPick={pickCustomer}
        onPickWalkIn={pickWalkIn}
        onClose={() => setCustPickerOpen(false)}
      />

      {/* Payment modal (Phase 3 + Phase 6a tax toggle) */}
      <PaymentModal
        open={payOpen}
        totalSatang={totals.totalSatang}
        vatSatang={totals.vatSatang}
        itemCount={itemCount}
        customer={customer}
        taxRequested={taxRequested}
        payLines={payLines}
        cashReceived={cashReceived}
        reference={reference}
        payError={payError}
        submitting={submitting}
        onSetMethod={setPayMethod}
        onSetAmount={setPayAmount}
        onAddLine={addPayLine}
        onRemoveLine={removePayLine}
        onCashReceived={onCashReceived}
        onSetReference={onSetReference}
        onToggleTax={toggleTax}
        onConfirm={confirmPayment}
        onClose={closePayment}
      />

      {/* Receipt modal — dismissal is New-Sale-only */}
      <ReceiptModal
        open={receiptOpen}
        order={receiptOrder}
        onPrint={printReceipt}
        onEmail={emailReceipt}
        onNewSale={newSale}
      />
    </div>
  );
}
