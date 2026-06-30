"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ScanBarcode, ShoppingCart, UserRound, AlertCircle, ChevronRight } from "lucide-react";
import type {
  Product,
  CartItem,
  CustomerDTO,
  DiscountType,
  HeldBillDTO,
  PayLine,
  PayMethod,
  OrderDTO,
  ShopSettingsDTO,
} from "@/types";
import { useToast } from "@/components/ToastProvider";
import { printReceiptWithSize } from "@/lib/receiptPrint";
import {
  bahtToSatang,
  computeTotals,
  remainingPaySatang,
  type PricingItem,
} from "@/lib/pricing";
import { CategoryPanel, type CategoryChip } from "@/components/pos/CategoryPanel";
import { ProductCard } from "@/components/pos/ProductCard";
import { CartLine } from "@/components/pos/CartLine";
import { TotalsBar } from "@/components/pos/TotalsBar";
import { PaymentModal } from "@/components/pos/PaymentModal";
import { CustomerPickerModal } from "@/components/pos/CustomerPickerModal";
import {
  CustomerFormModal,
  type CustomerFormInput,
} from "@/components/pos/CustomerFormModal";
import { ReceiptModal } from "@/components/pos/ReceiptModal";
import { HeldBillsModal } from "@/components/pos/HeldBillsModal";
import { BranchBadge } from "@/components/pos/BranchBadge";
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

/**
 * Map a physical KeyboardEvent.code to its layout-independent Latin character,
 * or null for keys we don't capture (Backspace, arrows, Shift, etc.). Used by
 * the barcode-scanner cadence detector (scan-thai-ime-fix) so a Thai OS keyboard
 * layout can't corrupt scanned digits — event.code is the physical key and is
 * independent of the active input-method layout.
 */
function codeToLatin(code: string): string | null {
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1];
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase();
  if (code === "Minus") return "-";
  if (code === "Period") return ".";
  return null;
}

type LoadState = "loading" | "ready" | "error";

export default function POSPage() {
  const { showToast } = useToast();

  const [products, setProducts] = useState<Product[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");

  const [cart, setCart] = useState<CartItem[]>([]);
  const [search, setSearch] = useState("");
  // Low-priority mirror of `search` used for the heavy grid filter only.
  // useDeferredValue lets React defer the (up to ~2020-card) grid re-render so the
  // urgent Enter→addToCart commit isn't blocked by a fast scanner's keystrokes.
  const deferredSearch = useDeferredValue(search);
  // Selection key: "all" (synthetic all-chip) or a real product category id.
  const [activeCat, setActiveCat] = useState<string>("all");

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

  // ---- add/edit-customer form (Phase 4 tax-invoice 4c) ----
  // The form modal is opened FROM the picker (add button or per-row pencil). On a
  // successful create/edit, `custRefreshSignal` is bumped to make the picker
  // re-fetch so the new/changed row appears; a create also auto-selects it.
  const [custFormOpen, setCustFormOpen] = useState(false);
  const [custEditing, setCustEditing] = useState<CustomerDTO | null>(null);
  const [custFormSubmitting, setCustFormSubmitting] = useState(false);
  const [custFormError, setCustFormError] = useState("");
  const [custRefreshSignal, setCustRefreshSignal] = useState(0);

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

  // ---- receipt print-size settings (Receipt print-size feature) ----
  // Fetched once on mount from GET /api/settings (requireUser). null until
  // resolved; printReceipt() falls back to the globals.css 80mm default while
  // null, so a slow/failed fetch never blocks printing.
  const [receiptSettings, setReceiptSettings] = useState<ShopSettingsDTO | null>(
    null
  );

  // ---- held bills (พักบิล) ----
  // `heldBillsOpen` toggles the held-bills list modal; `heldCount` is the cashier's
  // parked-bill count (drives the "บิลที่พักไว้ (N)" link under พักบิล). The count is
  // seeded on mount from GET /api/held-bills so the badge is correct after a reload,
  // then kept in sync optimistically by hold/resume/discard.
  const [heldBillsOpen, setHeldBillsOpen] = useState(false);
  const [heldCount, setHeldCount] = useState(0);
  // In-flight guard for พักบิล (M1): a double-tap before the POST returns would write
  // two identical HeldBill rows (the cart isn't cleared until res.ok) and
  // double-increment heldCount. While true, the hold button is disabled.
  const [isHolding, setIsHolding] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);

  // ---- barcode-scanner cadence capture (scan-thai-ime-fix) ----
  // A hardware scanner types fast; when the OS keyboard is Thai, its digits get
  // IME-mapped to Thai characters, so the search box fills with garbage and finds
  // nothing. We detect a fast keystroke burst (≤50ms apart) and reconstruct the
  // scanned code from event.code (layout-independent Latin), overwriting the box
  // with the correct digits. Slow manual typing (incl. Thai product NAMES) passes
  // through to the normal onChange untouched so name search still works.
  const lastKeyTimeRef = useRef(0);
  const scanBufRef = useRef("");
  const SCAN_GAP_MS = 50; // keystrokes ≤50ms apart = scanner burst

  // ---- checkout idempotency key (Sub-phase C) ----
  // A client-generated UUID identifying ONE checkout ATTEMPT. It is minted lazily
  // when a checkout is first submitted (confirmPayment) and REUSED across retries
  // of that same submission (a transient 500, or the user fixing cash and
  // re-confirming) so the server collapses duplicate POSTs to a single Order.
  // It is cleared on a successful checkout AND whenever the bill is abandoned
  // (cancel/hold/new-sale via clearBill) so the NEXT sale always mints a fresh
  // key. A ref (not state) — it never affects rendering and must update
  // synchronously within confirmPayment.
  const idemKeyRef = useRef<string | null>(null);

  /** Mint a fresh idempotency key, falling back if crypto.randomUUID is absent. */
  function freshIdemKey(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    // Defensive fallback for environments without crypto.randomUUID — still a
    // per-attempt unique token (time + randomness), well under the 64-char cap.
    return `pos-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  }

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

  // Receipt print-size settings (Receipt print-size feature). Fetched once on
  // mount so the receipt print path can apply the admin-configured size. Errors
  // are swallowed → receiptSettings stays null → printReceipt() falls back to the
  // globals.css 80mm default (printing must never break on a settings load).
  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/settings", { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { settings: ShopSettingsDTO } | null) => {
        if (ctrl.signal.aborted || !data?.settings) return;
        setReceiptSettings(data.settings);
      })
      .catch(() => {
        /* ignore — leave settings null → 80mm fallback */
      });
    return () => ctrl.abort();
  }, []);

  // Held-bill count (พักบิล). Fetched once on mount so the "บิลที่พักไว้ (N)" link is
  // correct after a reload (parked bills live on the server, scoped per-cashier).
  // Best-effort — a failed/slow load just leaves the count at 0; the list modal
  // re-fetches the authoritative list when opened.
  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/held-bills", { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: HeldBillDTO[] | null) => {
        if (ctrl.signal.aborted || !Array.isArray(data)) return;
        setHeldCount(data.length);
      })
      .catch(() => {
        /* ignore — leave the count at 0 */
      });
    return () => ctrl.abort();
  }, []);

  // Auto-focus the search/scan input on mount so a barcode scanner can fire immediately.
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Category chips derived data-driven from the fetched products' REAL categories
  // (KRS ItemTypename). One chip per distinct category keyed by category id,
  // ordered by product count descending (biggest categories first), preceded by a
  // synthetic "ทั้งหมด / All" chip. Products with no category are ignored for the
  // per-category chips (they still appear under "ทั้งหมด").
  const chips: CategoryChip[] = useMemo(() => {
    // id -> { name, count } accumulated over every product with a category.
    const byId = new Map<string, { name: string; count: number }>();
    for (const p of products) {
      const cat = p.category;
      if (!cat) continue;
      const existing = byId.get(cat.id);
      if (existing) {
        existing.count += 1;
      } else {
        byId.set(cat.id, { name: cat.name, count: 1 });
      }
    }
    const realChips: CategoryChip[] = Array.from(byId.entries())
      // Biggest categories first; ties broken by Thai-aware name order for stability.
      .sort((a, b) => b[1].count - a[1].count || a[1].name.localeCompare(b[1].name, "th"))
      .map(([id, { name, count }]) => ({
        key: id,
        label: name,
        sublabel: `${count} รายการ`,
      }));
    return [
      { key: "all", label: "ทั้งหมด", sublabel: `All items · ${products.length} รายการ` },
      ...realChips,
    ];
  }, [products]);

  // If the active category disappears (e.g. after a reload), fall back to all.
  useEffect(() => {
    if (activeCat !== "all" && !chips.some((c) => c.key === activeCat)) {
      setActiveCat("all");
    }
  }, [chips, activeCat]);

  // Filter: category (by real category id) + case-insensitive search across name +
  // sku + category name.
  const filtered = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
    return products.filter((p) => {
      const catOk = activeCat === "all" || p.category?.id === activeCat;
      if (!catOk) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        (p.category?.name ?? "").toLowerCase().includes(q) ||
        (p.barcode ?? "").toLowerCase().includes(q)
      );
    });
  }, [products, deferredSearch, activeCat]);

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
  // useCallback keeps addToCart referentially stable across renders so the
  // React.memo'd ProductCard only re-renders when its own props change — not on
  // every keystroke. setCart is a stable setter (no dep needed); showToast is a
  // stable useCallback from ToastProvider.
  const addToCart = useCallback((product: Product) => {
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
  }, [showToast]);

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
    // Drop the idempotency key — the bill is gone, so the NEXT checkout is a new
    // sale and must mint a fresh key (a successful checkout calls clearBill, as do
    // cancel/hold). Without this, the next sale would replay the just-completed
    // order (200) and never actually record the new sale.
    idemKeyRef.current = null;
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

  // ---- add/edit-customer (Phase 4 tax-invoice 4c) ----
  // Open the form in ADD mode (no editing row) from the picker's "เพิ่มลูกค้า".
  function openAddCustomer() {
    setCustEditing(null);
    setCustFormError("");
    setCustFormOpen(true);
  }

  // Open the form in EDIT mode pre-filled from a picker row.
  function openEditCustomer(c: CustomerDTO) {
    setCustEditing(c);
    setCustFormError("");
    setCustFormOpen(true);
  }

  function closeCustomerForm() {
    if (custFormSubmitting) return;
    setCustFormOpen(false);
    setCustFormError("");
  }

  // POST (create) or PATCH (edit) the customer, then refresh the picker. On a
  // create, auto-select the new customer (and apply the tax gate via pickCustomer)
  // so the cashier can immediately request a tax invoice for it. The server
  // re-validates and owns TAXID_TAKEN/VALIDATION/NOT_FOUND.
  async function submitCustomerForm(input: CustomerFormInput) {
    const editingId = custEditing?.id ?? null;
    setCustFormSubmitting(true);
    setCustFormError("");

    // PATCH (edit) vs POST (create) build the payload differently:
    //  - EDIT: send the optional keys UNCONDITIONALLY so the server can CLEAR
    //    them. The server schema transforms "" → null for taxId/address/phone
    //    (clearing the column), so omitting an emptied field (the old behavior)
    //    would silently keep the stale value. buyerBranchCode can't be "" (fails
    //    the 5-digit rule) so an empty branch sends the HQ default "00000".
    //  - CREATE: omit empty optionals (defaulting to null/"00000" server-side).
    const payload: Record<string, string> = { name: input.name };
    if (editingId) {
      payload.taxId = input.taxId;
      payload.address = input.address;
      payload.phone = input.phone;
      payload.buyerBranchCode =
        input.buyerBranchCode.length > 0 ? input.buyerBranchCode : "00000";
    } else {
      if (input.taxId.length > 0) payload.taxId = input.taxId;
      if (input.address.length > 0) payload.address = input.address;
      if (input.phone.length > 0) payload.phone = input.phone;
      if (input.buyerBranchCode.length > 0)
        payload.buyerBranchCode = input.buyerBranchCode;
    }

    try {
      const res = await fetch(
        editingId ? `/api/customers/${editingId}` : "/api/customers",
        {
          method: editingId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );

      if (!res.ok) {
        let code = "";
        try {
          const body = (await res.json()) as { code?: string };
          code = body?.code ?? "";
        } catch {
          /* non-JSON error body — fall through to the generic message */
        }
        const message =
          code === "TAXID_TAKEN"
            ? "เลขผู้เสียภาษีนี้ถูกใช้งานแล้ว"
            : code === "VALIDATION"
              ? "ข้อมูลไม่ถูกต้อง ตรวจสอบเลขภาษี/รหัสสาขาอีกครั้ง"
              : code === "NOT_FOUND"
                ? "ไม่พบลูกค้ารายนี้ (อาจถูกลบไปแล้ว)"
                : "บันทึกลูกค้าไม่สำเร็จ ลองใหม่อีกครั้ง";
        setCustFormError(message);
        return;
      }

      const saved = (await res.json()) as CustomerDTO;
      setCustFormOpen(false);
      // Make the picker re-fetch so the new/edited row is reflected.
      setCustRefreshSignal((n) => n + 1);

      if (editingId) {
        // Edit: if the currently-selected customer was the one edited, refresh the
        // selection (and re-apply the tax gate in case its taxId changed).
        if (customer?.id === editingId) pickCustomer(saved);
        showToast("บันทึกการแก้ไขลูกค้าแล้ว · Customer updated");
      } else {
        // Create: auto-select the new customer so the sale continues with it.
        pickCustomer(saved);
        showToast("เพิ่มลูกค้าแล้ว · Customer added");
      }
    } catch {
      setCustFormError("เชื่อมต่อไม่สำเร็จ ลองใหม่อีกครั้ง");
    } finally {
      setCustFormSubmitting(false);
    }
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

  // Park the current cart to the server (พักบิล). Builds a SNAPSHOT of the cart (line
  // items + the product name/price/sku for list display) + the selected customer + the
  // bill-discount/tax state, POSTs it, and on success clears the cart for the next sale.
  // The snapshot is display/restore only — checkout still recomputes all money/stock on
  // resume, so the captured prices are never trusted. On failure the cart is NOT cleared
  // so the cashier doesn't lose the bill.
  async function holdBill() {
    if (isHolding) return;
    if (cart.length === 0) {
      showToast("ตะกร้าว่าง ไม่สามารถพักบิลได้");
      return;
    }
    const items = cart.map((i) => ({
      productId: i.product.id,
      quantity: i.quantity,
      lineDiscountSatang: i.lineDiscountSatang,
      // Captured for the held-bills list display only (NOT a price source).
      productName: i.product.name,
      productPrice: i.product.price,
      productSku: i.product.sku,
    }));
    const totalQty = cart.reduce((s, i) => s + i.quantity, 0);
    const discountValue = Number(discountDraft.trim()) || 0;
    const label = `${new Date().toLocaleTimeString("th-TH", {
      hour: "2-digit",
      minute: "2-digit",
    })} · ${totalQty} รายการ`;
    setIsHolding(true);
    try {
      const res = await fetch("/api/held-bills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label,
          cartJson: { items, customer },
          customerId: customer?.id ?? null,
          discountType,
          discountValue,
          taxRequested,
          totalSatang: totals.totalSatang,
        }),
      });
      if (!res.ok) {
        showToast("พักบิลไม่สำเร็จ ลองใหม่อีกครั้ง");
        return;
      }
      clearBill();
      setHeldCount((c) => c + 1);
      showToast("พักบิลไว้แล้ว");
    } catch {
      showToast("พักบิลไม่สำเร็จ ลองใหม่อีกครั้ง");
    } finally {
      setIsHolding(false);
    }
  }

  // Resume a parked bill back into the cart (เรียกคืนบิล). DELETE the held bill FIRST
  // (atomic claim) so two terminals can't restore the same bill twice — a 404 means it
  // was already resumed/discarded elsewhere. On a successful claim, rebuild the cart from
  // the snapshot: lines whose product is still in the loaded products list are restored;
  // lines whose product is gone (deactivated/removed) are DROPPED and reported by SKU.
  async function resumeBill(id: string, bill: HeldBillDTO) {
    try {
      const res = await fetch(`/api/held-bills/${id}`, { method: "DELETE" });
      if (res.status === 404) {
        showToast("บิลนี้ถูกเรียกคืนไปแล้ว");
        setHeldCount((c) => Math.max(c - 1, 0));
        return;
      }
      if (!res.ok) {
        showToast("เรียกคืนบิลไม่สำเร็จ ลองใหม่อีกครั้ง");
        return;
      }
    } catch {
      showToast("เรียกคืนบิลไม่สำเร็จ ลองใหม่อีกครั้ง");
      return;
    }

    const restored: CartItem[] = [];
    const dropped: string[] = [];
    for (const item of bill.cartJson.items) {
      const product = products.find((p) => p.id === item.productId);
      if (product) {
        restored.push({
          product,
          quantity: item.quantity,
          lineDiscountSatang: item.lineDiscountSatang,
        });
      } else {
        dropped.push(item.productSku);
      }
    }

    setCart(restored);
    setDiscountType(bill.discountType);
    setDiscountDraft(bill.discountValue > 0 ? String(bill.discountValue) : "");
    setCustomer(bill.cartJson.customer ?? null);
    setTaxRequested(bill.taxRequested);
    // A resumed bill is a fresh checkout attempt — drop any stale idempotency key so the
    // next pay mints a new one (and never replays a previous order).
    idemKeyRef.current = null;
    setHeldBillsOpen(false);
    setHeldCount((c) => Math.max(c - 1, 0));
    showToast(
      dropped.length > 0
        ? `เรียกคืนบิลแล้ว (ข้าม ${dropped.length} รายการที่ปิดการขาย: ${dropped.join(
            ", "
          )})`
        : "เรียกคืนบิลแล้ว"
    );
  }

  // Discard a parked bill without resuming it (ลบบิลที่พักไว้). A 404 (already gone) is
  // treated the same as a successful delete — either way the bill is no longer parked.
  // Returns true on success (so the modal keeps its optimistic removal) or false on
  // failure (so the modal can roll the row back — M2/L1).
  async function discardHeldBill(id: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/held-bills/${id}`, { method: "DELETE" });
      if (res.ok || res.status === 404) {
        setHeldCount((c) => Math.max(c - 1, 0));
        showToast("ลบบิลที่พักไว้แล้ว");
        return true;
      }
      showToast("ลบบิลไม่สำเร็จ ลองใหม่อีกครั้ง");
      return false;
    } catch {
      showToast("ลบบิลไม่สำเร็จ ลองใหม่อีกครั้ง");
      return false;
    }
  }

  // Enter on an exact SKU/barcode match = scan-to-cart, PLUS cadence-based
  // scanner capture: a fast keystroke burst is reconstructed from event.code
  // (layout-independent Latin) so a Thai OS keyboard can't corrupt scanned
  // digits, while slow human typing (incl. Thai product names) passes through to
  // onChange untouched.
  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const now = e.timeStamp;
    const gap = now - lastKeyTimeRef.current;
    lastKeyTimeRef.current = now;

    if (e.key === "Enter") {
      // Prefer the reconstructed scan buffer (Latin) when it holds a plausible
      // code (≥3 chars); otherwise fall back to the LIVE DOM value (manual
      // typing — not the stale React `search` closure). A fast scanner can fire
      // Enter before React commits the last keystroke into `search`, so reading
      // currentTarget.value avoids missing the exact barcode/sku match.
      const q = (
        scanBufRef.current.length >= 3
          ? scanBufRef.current
          : e.currentTarget.value ?? search
      )
        .trim()
        .toLowerCase();
      scanBufRef.current = "";
      if (!q) return;
      const match = products.find(
        (p) => (p.barcode != null && p.barcode.toLowerCase() === q) || p.sku.toLowerCase() === q
      );
      if (match) {
        addToCart(match);
        setSearch("");
      }
      return;
    }

    // Printable physical key? Non-printable keys (Backspace, arrows, Shift, …)
    // map to null and return early, leaving normal typing untouched.
    const ch = codeToLatin(e.code);
    if (ch === null) return;

    if (gap < SCAN_GAP_MS) {
      // Scanner burst: reconstruct from layout-independent Latin and overwrite
      // the box, visually correcting any Thai-IME-mapped characters.
      e.preventDefault();
      scanBufRef.current += ch;
      setSearch(scanBufRef.current);
    } else {
      // First key of a burst OR slow manual typing. Seed a fresh buffer with the
      // Latin char but DO NOT preventDefault — let the IME/onChange handle it so
      // normal (Thai) name typing still populates `search`. If the next key
      // arrives fast we enter scanner mode and setSearch overwrites with the
      // corrected buffer.
      //
      // First-character caveat: if a scanner's first→second gap exceeds
      // SCAN_GAP_MS the leading char may pass through the IME (Thai). Rare — most
      // scanners burst every char — and the buffer self-corrects from the 2nd
      // fast char onward.
      scanBufRef.current = ch;
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
    // Split sum must equal the total EXACTLY (FIX 4 — client/server parity). The
    // server requires exact satang equality (orders/route.ts PAYMENT_MISMATCH), so
    // the client mirrors it: any nonzero satang difference is rejected here rather
    // than passing the client and failing the server with a confusing 422. The
    // auto-fill (toFixed(2) on the split lines) keeps a normal split exactly equal.
    if (paidSatang - totalSatang !== 0) {
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

    // FIX D — amountPaid/change are SERVER-computed (Sub-phase A): the server
    // derives them from the payment lines and never trusts client-sent values,
    // so they are not part of the POST body. The former client-side amountPaid/
    // change computations here were dead and have been removed. The cash-
    // sufficiency check above (hasCash / cashDueSatang / receivedSatang) is the
    // only remaining client-side cash math and is kept as a UX pre-check.

    setSubmitting(true);
    setPayError("");
    // Mint the idempotency key once per submission and reuse it across retries:
    // if a previous confirm attempt for this same bill already created one (e.g.
    // it failed with a transient error and the cashier re-confirmed), reuse it so
    // the server collapses the duplicate POST to a single Order. A new sale starts
    // with idemKeyRef cleared (clearBill / success below) → a fresh key is minted.
    if (!idemKeyRef.current) {
      idemKeyRef.current = freshIdemKey();
    }
    const idempotencyKey = idemKeyRef.current;
    try {
      const trimmedRef = reference.trim();
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: cart.map((i) => ({
            productId: i.product.id,
            quantity: i.quantity,
            // Per-line discount (ส่วนลดรายการ) in integer satang — the server
            // folds this into its authoritative recompute so its total matches
            // the cart. Omitted when 0.
            ...(i.lineDiscountSatang > 0
              ? { lineDiscountSatang: i.lineDiscountSatang }
              : {}),
          })),
          paymentLines: payLines.map((l) => ({
            method: methodToEnum(l.method),
            amount: bahtToSatang(l.amount) / 100,
            reference: trimmedRef.length > 0 ? trimmedRef : null,
          })),
          // Bill-level discount INPUT (not an amount). The server recomputes ALL
          // money (subtotal/discount/tax/total/amountPaid/change) from DB prices +
          // these two fields — the previously-sent computed money values are no
          // longer trusted and are intentionally omitted.
          discountType,
          discountValue: (() => {
            const v = Number(discountDraft.trim());
            return Number.isFinite(v) && v > 0 ? v : 0;
          })(),
          customerId: customer?.id ?? null,
          taxRequested,
          // Per-attempt idempotency key (Sub-phase C) — same key across retries
          // of THIS submission; the server replays the existing order on a dupe.
          idempotencyKey,
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
      // Inject the admin-configured @page size before printing (Receipt print-size
      // feature). Falls back to the globals.css 80mm default when settings haven't
      // loaded. The A4 tax-invoice path is untouched.
      printReceiptWithSize(receiptSettings);
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
      : chips.find((c) => c.key === activeCat)?.label ?? "สินค้า";

  // Cap the rendered cards DURING SEARCH/SCAN only (plain category browsing still
  // renders every card). While scanning, the grid is irrelevant, so slicing to
  // GRID_CAP cuts the deferred render work ~25× and keeps the main thread free for
  // the urgent Enter→addToCart commit.
  const GRID_CAP = 80;
  const isSearching = deferredSearch.trim().length > 0;
  const displayProducts =
    isSearching && filtered.length > GRID_CAP
      ? filtered.slice(0, GRID_CAP)
      : filtered;

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
        <header className="pos-header flex items-center gap-3.5">
          <div className="flex-1">
            <h1 className="m-0 text-[24px] font-bold leading-[1.08] tracking-tight">
              ขายหน้าร้าน
            </h1>
            <p className="mt-1 text-[12.5px]" style={{ color: "var(--muted)" }}>
              POS Checkout · เลือกสินค้า, ปรับส่วนลด, ปิดการขาย
            </p>
          </div>
          {/* Logged-in user's warehouse + branch by NAME (Branch/Warehouse).
              Compact, self-degrading chip — never alters the .pos-header height. */}
          <BranchBadge />
        </header>

        {/* Search / scan */}
        <section>
          <label
            className="pos-search flex items-center gap-[11px] rounded-[18px] border bg-white px-4"
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
              <div className="product-grid grid">
                {displayProducts.map((p) => (
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
            {isSearching && filtered.length > GRID_CAP && (
              <p
                className="mt-2 text-center text-[11px]"
                style={{ color: "var(--muted)" }}
              >
                แสดง {GRID_CAP} รายการแรก · พิมพ์/สแกนให้ละเอียดขึ้นเพื่อค้นหาเพิ่ม
              </p>
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
          isHolding={isHolding}
          heldCount={heldCount}
          onOpenHeldBills={() => setHeldBillsOpen(true)}
          onPay={openPayment}
          payDisabled={cart.length === 0 || submitting}
          checkingOut={submitting}
        />
      </aside>

      {/* Customer picker (Phase 6a) + add/edit affordances (Phase 4 4c) */}
      <CustomerPickerModal
        open={custPickerOpen}
        onPick={pickCustomer}
        onPickWalkIn={pickWalkIn}
        onClose={() => setCustPickerOpen(false)}
        onAddCustomer={openAddCustomer}
        onEditCustomer={openEditCustomer}
        refreshSignal={custRefreshSignal}
      />

      {/* Add / edit-customer form (Phase 4 tax-invoice 4c) */}
      <CustomerFormModal
        open={custFormOpen}
        editing={custEditing}
        submitting={custFormSubmitting}
        error={custFormError}
        onClose={closeCustomerForm}
        onSubmit={submitCustomerForm}
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

      {/* Held-bills (พักบิล) list — resume / discard a parked bill */}
      <HeldBillsModal
        open={heldBillsOpen}
        onClose={() => setHeldBillsOpen(false)}
        onResume={resumeBill}
        onDiscard={discardHeldBill}
      />
    </div>
  );
}
