"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ScanBarcode, ShoppingCart, UserRound, AlertCircle, ChevronRight, Gift } from "lucide-react";
import type {
  Product,
  CartItem,
  CustomerDTO,
  DiscountType,
  HeldBillDTO,
  PayLine,
  PayMethod,
  OrderDTO,
  RewardDTO,
  ShopSettingsDTO,
} from "@/types";
import { useToast } from "@/components/ToastProvider";
import {
  detectPrintAgent,
  resolveReceiptPrintService,
  captureAndPrintReceiptImage,
} from "@/lib/print";
import {
  bahtToSatang,
  computeTotals,
  remainingPaySatang,
  type PricingItem,
  type BillDiscount,
} from "@/lib/pricing";
import {
  applyPromotions,
  linePromoCandidateSatang,
  type ActivePromotion,
  type PromoCartLine,
} from "@/lib/promotionEngine";
// Loyalty redemption preview (loyalty program, Phase 2). The SAME pure satang-exact
// value helper the server folds in, so the client preview equals the server recompute
// to the satang. The input is clamped to min(balance, maxByBill) before this, so every
// previewed point maps exactly to its value (no fractional point).
import { computeRedemption } from "@/lib/loyalty";
import {
  promoBadgeLabel,
  promoRewardLabel,
} from "@/components/promotions/promotionMeta";
import { useKrsEvents } from "@/lib/useKrsEvents";
import type { KrsStockUpdateItem } from "@/lib/krsEventTypes";
import { useRole } from "@/components/RoleProvider";
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
import { RewardPickerModal } from "@/components/pos/RewardPickerModal";
import { HeldBillsModal } from "@/components/pos/HeldBillsModal";
import { BranchBadge } from "@/components/pos/BranchBadge";
import { SilentPrintOnboardingModal } from "@/components/pos/SilentPrintOnboardingModal";
import { methodToEnum } from "@/components/pos/paymentMeta";
import {
  persistKioskModeIfFlagged,
  markDismissed,
  shouldShowOnboardingModal,
} from "@/lib/kioskMode";

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

/**
 * Checkout POST timeout (ms). Bounds the fetch("/api/orders") round-trip so a
 * dead network / hung server can never wedge the payment modal forever. 30s is
 * generous for a normal order POST; on abort the outcome is UNKNOWN, so the
 * bill + idempotency key are left untouched and the cashier simply retries
 * (same key → the server collapses a duplicate to one Order).
 */
const ORDER_POST_TIMEOUT_MS = 30000;

/**
 * Agent print watchdog (ms). The capture→render→POST chain is per-step
 * time-capped, but if any await still silently pends, this forces the
 * back-to-new-sale reset — the sale is already recorded, only the receipt is
 * lost. Generous: covers a slow shop PC's html2canvas render + the 8s POST cap.
 */
const PRINT_WATCHDOG_MS = 20000;

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
  // The signed-in user's assigned KRS warehouse (null when unassigned). Read from the
  // session via RoleProvider — the SAME source GET /api/products uses server-side to
  // scope display stock. Consumed by the SSE stock patch so a live push resolves the
  // user's per-warehouse qty instead of overwriting it with the global figure (Item B).
  const { warehouseCode } = useRole();

  const [products, setProducts] = useState<Product[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");

  // Currently-effective promotions (promotions program, Phase 7). Fetched on mount,
  // then refetched after every settled sale AND on a PAYMENT_MISMATCH (a promo may have
  // expired mid-bill), so the on-screen preview uses the SAME effective set the server
  // recomputes against. The server stays authoritative — this is preview only.
  const [activePromos, setActivePromos] = useState<ActivePromotion[]>([]);

  const [cart, setCart] = useState<CartItem[]>([]);
  // Latest-cart ref (mirrors `cart` every render). Lets the referentially-stable
  // `addToCart` useCallback read the CURRENT cart quantity for its stock clamp WITHOUT
  // taking `cart` as a dep (which would defeat the React.memo'd ProductCard). Same
  // "latest ref" pattern useKrsEvents uses for its handlers.
  const cartRef = useRef<CartItem[]>(cart);
  cartRef.current = cart;
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

  // ---- points redemption (loyalty program, Phase 2) ----
  // Whole points the cashier wants to spend as a baht discount (raw text mirror so it
  // can be cleared). The totals memo below folds the resolved ฿ value into the bill as
  // the THIRD bill-discount slice (after promo + manual), so the displayed total reflects
  // the redemption live. Clamped to the member's redeemable max on change; reset on a new
  // sale / customer switch / PAYMENT_MISMATCH. Server stays authoritative (it recomputes).
  const [redeemDraft, setRedeemDraft] = useState("");

  // ---- reward redemption (loyalty program, Phase 3B) ----
  // `rewards` = the store's active rewards from GET /api/rewards?view=pos (fetched on mount +
  // refetched after a settled sale / on PAYMENT_MISMATCH). `rewardPickerOpen` toggles the
  // "แลกของรางวัล" picker. `selectedRewards` is the SOURCE OF TRUTH for which rewards the
  // member is redeeming this bill — each adds 1 free unit of its product to the cart, drives
  // the per-line reward discount folded into the totals preview, and supplies the
  // redeemRewardIds sent at checkout. Reset on a new/abandoned bill, customer switch, and
  // PAYMENT_MISMATCH. Server stays authoritative (it re-validates every reward + the spend).
  const [rewards, setRewards] = useState<RewardDTO[]>([]);
  const [rewardPickerOpen, setRewardPickerOpen] = useState(false);
  const [selectedRewards, setSelectedRewards] = useState<RewardDTO[]>([]);

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

  // ---- receipt state (pos-autoprint-receipt) ----
  // On a successful checkout the receipt is NOT shown as a page. Instead it is
  // mounted SCREEN-HIDDEN and printed automatically, then the cashier goes
  // straight to a fresh sale. `receiptOrder` holds the just-created order to
  // render/print; `autoPrintOpen` gates the screen-hidden auto-print overlay.
  const [receiptOrder, setReceiptOrder] = useState<OrderDTO | null>(null);
  const [autoPrintOpen, setAutoPrintOpen] = useState(false);
  // ---- agent image-print capture (pos-receipt-image) ----
  // When the local ESC/POS agent is present the receipt is printed as a browser-
  // rasterized PNG (so Thai always prints correctly). This gates the OFF-SCREEN,
  // renderable `.print-receipt` DOM (<ReceiptModal captureMode/>) that html2canvas
  // rasterizes — distinct from `autoPrintOpen`, which mounts the display:none
  // paper for the browser `window.print()` fallback path.
  const [captureOpen, setCaptureOpen] = useState(false);

  // ---- receipt print-size settings (Receipt print-size feature) ----
  // Fetched once on mount from GET /api/settings (requireUser). null until
  // resolved; the auto-print path (printReceiptWithSize) falls back to the
  // globals.css 80mm default while null, so a slow/failed fetch never blocks
  // printing. Also passed to the receipt as its pre-loaded seller header.
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

  // ---- silent-print onboarding (Plan A) ----
  // First-run guide surfacing the kiosk-print setup file. Gated by localStorage
  // via @/lib/kioskMode: shown once on a normal browser, suppressed after the
  // operator dismisses it, and suppressed whenever the app was opened via the
  // kiosk shortcut (?kiosk=1 persisted on first load).
  const [onboardingOpen, setOnboardingOpen] = useState(false);

  // ---- local print-agent detection (Plan B) ----
  // Whether the silent localhost ESC/POS print agent answered its /health ping on
  // this page load. Detected once on mount (fail-open false = agent absent →
  // browser print path). Drives BOTH the receipt-print backend selection at
  // checkout AND onboarding-modal suppression (an installed agent already gives
  // dialog-free printing, so the setup guide is unnecessary).
  const [agentAvailable, setAgentAvailable] = useState(false);

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

  // Load the effective promotions (promotions program, Phase 7). Reused by the mount
  // effect (with an abort signal) AND by the fire-and-forget refetch after a settled
  // sale / on a PAYMENT_MISMATCH. Best-effort: a failed/slow load keeps the last-known
  // set (or []), which just previews fewer promos — the server recompute is the source
  // of truth, so an under-preview can only ever be corrected upward by PAYMENT_MISMATCH.
  const loadPromotions = useCallback((signal?: AbortSignal) => {
    fetch("/api/promotions?view=pos", signal ? { signal } : undefined)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: ActivePromotion[] | null) => {
        if (signal?.aborted || !Array.isArray(data)) return;
        setActivePromos(data);
      })
      .catch(() => {
        /* ignore — keep the last-known promotions (server stays authoritative) */
      });
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    loadPromotions(ctrl.signal);
    return () => ctrl.abort();
  }, [loadPromotions]);

  // Load the active rewards (loyalty program, Phase 3B). Reused by the mount effect (with an
  // abort signal) AND by the fire-and-forget refetch after a settled sale / on a
  // PAYMENT_MISMATCH (a reward may have been toggled off, or the balance changed). Best-effort:
  // a failed/slow load keeps the last-known set (or []). The server re-validates every reward
  // at checkout, so a stale client list can only ever be corrected downward by a 422.
  const loadRewards = useCallback((signal?: AbortSignal) => {
    fetch("/api/rewards?view=pos", signal ? { signal } : undefined)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: RewardDTO[] | null) => {
        if (signal?.aborted || !Array.isArray(data)) return;
        setRewards(data);
      })
      .catch(() => {
        /* ignore — keep the last-known rewards (server stays authoritative) */
      });
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    loadRewards(ctrl.signal);
    return () => ctrl.abort();
  }, [loadRewards]);

  // ---- live KRS stock/product push (krs-realtime-inbound P2) ----
  // Patch the grid in place from an SSE `stock-update`: rewrite ONLY the changed
  // skus' stock and RETURN THE SAME OBJECT for every untouched (and no-op) product so
  // the React.memo'd ProductCard re-renders only the cards that actually changed. If
  // nothing changed, return the previous array unchanged (no re-render at all).
  //
  // WAREHOUSE-AWARE (Item B): each item carries the GLOBAL `stock` plus an optional
  // per-warehouse `warehouse` breakdown. We resolve the DISPLAY stock the same way GET
  // /api/products does — an assigned user (warehouseCode set) whose warehouse appears in
  // the breakdown gets THAT qty; everyone else (unassigned, or no breakdown row for their
  // warehouse) falls back to the global `stock`. This stops a live push from overwriting
  // a warehouse-scoped figure (e.g. 339) with the global one (e.g. 338 = warehouse − locally-
  // sold-not-yet-synced). Depends on `warehouseCode`; useKrsEvents reads handlers via a ref
  // so recreating this callback never reconnects the SSE stream.
  const patchStockBySku = useCallback(
    (items: KrsStockUpdateItem[]) => {
      if (items.length === 0) return;
      const displayBySku = new Map<string, number>();
      for (const item of items) {
        let display = item.stock;
        if (warehouseCode !== null && item.warehouse) {
          const row = item.warehouse.find((w) => w.code === warehouseCode);
          if (row) display = row.qty;
        }
        displayBySku.set(item.sku, display);
      }
      setProducts((prev) => {
        let changed = false;
        const next = prev.map((p) => {
          const nextStock = displayBySku.get(p.sku);
          if (nextStock === undefined || nextStock === p.stock) return p; // same ref
          changed = true;
          return { ...p, stock: nextStock };
        });
        return changed ? next : prev;
      });
    },
    [warehouseCode]
  );

  // Background product refetch for an SSE `product-update` (name/price/active/image
  // changed KRS-side). Deliberately does NOT flip loadState to "loading" (that would
  // blank the grid) — it silently swaps in the fresh list on success and keeps the
  // last-known list on failure. product-update is rare, so replacing every product
  // reference (a full grid re-render) here is acceptable; the mount fetch remains the
  // source of truth for first paint / fallback.
  const refetchProducts = useCallback(() => {
    fetch("/api/products")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Product[] | null) => {
        if (Array.isArray(data)) setProducts(data);
      })
      .catch(() => {
        /* keep the last-known products — server stays authoritative */
      });
  }, []);

  useKrsEvents({
    onStockUpdate: patchStockBySku,
    onProductUpdate: refetchProducts,
  });

  // Receipt print-size settings (Receipt print-size feature). Fetched once on
  // mount so the receipt print path can apply the admin-configured size. Errors
  // are swallowed → receiptSettings stays null → the auto-print path falls back
  // to the globals.css 80mm default (printing must never break on a settings load).
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

  // Print-agent detection + silent-print onboarding (Plan B extends Plan A).
  // Runs once on mount, in order:
  //   1. persistKioskModeIfFlagged() — persist the ?kiosk=1 shortcut signal FIRST
  //      so a kiosk session is recognized before the onboarding read below.
  //   2. detectPrintAgent() — probe the localhost ESC/POS agent (cached, bounded
  //      ~1500ms, fail-open false). NON-blocking: nothing waits on it except the
  //      two state updates it triggers.
  //   3. When it settles: record availability, and decide the onboarding modal.
  //      The modal decision WAITS for detection so an installed agent SUPPRESSES
  //      the guide and there is no first-run flash before the probe resolves
  //      (onboardingOpen starts false and is only ever set true here).
  // Suppression = agentAvailable OR kioskMode OR dismissed. Only a normal browser
  // with NO agent, NOT a kiosk session, and NOT previously dismissed shows it.
  useEffect(() => {
    persistKioskModeIfFlagged();
    let cancelled = false;
    // detectPrintAgent never rejects (fail-open) → a bare .then is safe.
    void detectPrintAgent().then((available) => {
      if (cancelled) return;
      setAgentAvailable(available);
      if (!available && shouldShowOnboardingModal()) {
        setOnboardingOpen(true);
      }
    });
    return () => {
      cancelled = true;
    };
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

  // Best qty-1 promo badge per product (promotions program, Phase 7). For each product
  // we rank its scoped line-level promos at qty 1 with the SAME engine helper the cart
  // uses (largest discount wins; ties → smallest id, mirroring the engine's pickBest),
  // so the card preview never drifts from the applied discount. %/฿/fixed → an honest
  // struck price at qty 1; BUY_X_GET_Y → the rule label only (its effective price
  // depends on qty). Threshold promos have no per-product badge. Rebuilt ONLY when
  // promos/products change, so each product's badge object stays referentially stable
  // and the React.memo'd ProductCard doesn't re-render on cart/keystroke churn.
  const promoBadgeByProductId = useMemo(() => {
    const map = new Map<
      string,
      { label: string; struckPrice?: boolean; promoUnitPriceSatang?: number }
    >();
    const linePromos = activePromos.filter(
      (p) =>
        p.type === "PRODUCT_DISCOUNT" ||
        p.type === "FIXED_PRICE" ||
        p.type === "BUY_X_GET_Y"
    );
    if (linePromos.length === 0) return map;
    for (const product of products) {
      const priceSatang = bahtToSatang(product.price);
      if (priceSatang <= 0) continue;
      const scoped = linePromos.filter((p) => p.productIds?.includes(product.id));
      if (scoped.length === 0) continue;
      // Rank at qty 1: highest discount first, ties broken by smallest id (engine parity).
      const ranked = scoped
        .map((promo) => ({
          promo,
          discount: linePromoCandidateSatang(promo, priceSatang, 1),
        }))
        .sort(
          (a, b) =>
            b.discount - a.discount || (a.promo.id < b.promo.id ? -1 : 1)
        );
      const best = ranked[0];
      if (best.promo.type === "BUY_X_GET_Y") {
        // qty-1 discount is 0 (no full group yet) — show the rule label, no struck price.
        const label = promoBadgeLabel(best.promo);
        if (label) map.set(product.id, { label });
        continue;
      }
      // PRODUCT_DISCOUNT / FIXED_PRICE: honest struck price at qty 1 (skip if 0/malformed).
      if (best.discount <= 0) continue;
      const label = promoBadgeLabel(best.promo);
      if (!label) continue;
      map.set(product.id, {
        label,
        struckPrice: true,
        promoUnitPriceSatang: Math.max(priceSatang - best.discount, 0),
      });
    }
    return map;
  }, [activePromos, products]);

  // ProductIds that carry an active LINE-level promotion (loyalty program, Phase 3B —
  // FIX A). A reward's free unit can't be honestly stacked on a product that already
  // has a line-level promo (PRODUCT_DISCOUNT / FIXED_PRICE / BUY_X_GET_Y — all
  // product-scoped; a BILL_THRESHOLD promo is bill-level and does NOT conflict), so the
  // reward picker excludes those rewards and `toggleReward` refuses to add them. Built
  // from the SAME `activePromos` the server derives its `REWARD_PROMO_CONFLICT` set from,
  // so the cashier is never offered a reward the server would 422.
  const linePromoProductIds = useMemo(() => {
    const set = new Set<string>();
    for (const p of activePromos) {
      if (
        p.type === "PRODUCT_DISCOUNT" ||
        p.type === "FIXED_PRICE" ||
        p.type === "BUY_X_GET_Y"
      ) {
        if (Array.isArray(p.productIds)) {
          for (const id of p.productIds) set.add(id);
        }
      }
    }
    return set;
  }, [activePromos]);

  // Selected-reward rollups (loyalty program, Phase 3B). `rewardCountByProduct` = how many
  // free units per product (drives the per-line reward discount injected into the totals
  // preview + the gold "ของรางวัล" cart chip); `rewardPointsTotal` = Σ the selected rewards'
  // pointsCost (the reward slice of the points spend, combined with the baht redemption).
  const rewardCountByProduct = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of selectedRewards) {
      m.set(r.productId, (m.get(r.productId) ?? 0) + 1);
    }
    return m;
  }, [selectedRewards]);
  const rewardPointsTotal = useMemo(
    () => selectedRewards.reduce((s, r) => s + r.pointsCost, 0),
    [selectedRewards]
  );

  // Totals via the pure integer-satang engine, now routed through the promotion engine
  // (promotions program, Phase 7). We run `applyPromotions` over the cart + effective
  // promos + the manual bill discount, then feed its `combinedLineDiscountSatang`
  // (per line) and `combinedBill` into `computeTotals` — the IDENTICAL inputs the
  // server uses (parity guaranteed by promotionEngine tests), so the on-screen total
  // equals the server's authoritative recompute. `application` carries the per-line +
  // bill promo breakdown for the cart/totals/payment surfaces.
  const {
    totals,
    application,
    redemptionSatang,
    effectiveRedeemPoints,
    maxRedeemablePoints,
  } = useMemo(() => {
    // Reward injection (loyalty program, Phase 3B) — MIRRORS the server: a redeemed reward's
    // free-unit value (count × unit price) is ADDED to that product line's manual line
    // discount BEFORE applyPromotions, so the engine subtotal nets the reward and the
    // on-screen total equals the authoritative recompute. The cart holds one line per product,
    // so a per-product injection lands whole.
    const promoLines: PromoCartLine[] = cart.map((i) => {
      const priceSatang = bahtToSatang(i.product.price);
      const rewardUnits = rewardCountByProduct.get(i.product.id) ?? 0;
      return {
        productId: i.product.id,
        priceSatang,
        quantity: i.quantity,
        manualLineDiscountSatang: i.lineDiscountSatang + rewardUnits * priceSatang,
      };
    });
    const value = Number(discountDraft.trim());
    const manualBill: BillDiscount = {
      type: discountType,
      value: Number.isFinite(value) ? value : 0,
    };
    const application = applyPromotions(promoLines, activePromos, manualBill);

    // --- points-redemption preview (loyalty program, Phase 2) — client mirror of the
    // server. remainingBill = subtotal − promoBill − manual (what a further bill discount
    // can still cover). The cap + value are derived from the SHARED `computeRedemption`
    // engine so client and server agree EXACTLY — including the never-zero-the-bill floor
    // (`maxByBill = floor((remaining − 1) / pointValue)`, FIX 2): the UI never advertises a
    // points count that would drive the bill to 0. The redeem input is clamped to
    // `maxRedeemablePoints` on change, so `effectiveRedeemPoints` == the typed value here.
    // Only a loyalty-ON store with an enrolled member redeems; otherwise 0 (byte-identical). ---
    const loyaltyOn = receiptSettings?.loyaltyEnabled === true;
    const perPointSatang = receiptSettings?.redeemPointValueSatang ?? 0;
    const minRedeemPoints = receiptSettings?.minRedeemPoints ?? 0;
    const isMember = customer?.isMember === true;
    const balance = isMember ? customer?.pointsBalance ?? 0 : 0;
    // Reward points are committed FIRST, so the baht redemption may only spend what the
    // balance has LEFT after the selected rewards (loyalty program, Phase 3B). Capping the
    // baht redeem at `balance − rewardPointsTotal` keeps the COMBINED spend ≤ balance, so the
    // server's combined-total guard never rejects a bill the cashier built through the UI.
    const balanceForBaht = Math.max(balance - rewardPointsTotal, 0);
    const remainingBillSatang = Math.max(
      application.subtotalSatang -
        application.promoBillDiscountSatang -
        application.manualBillDiscountSatang,
      0
    );
    const requestedRedeem = (() => {
      const n = Math.trunc(Number(redeemDraft.trim()));
      return Number.isFinite(n) && n > 0 ? n : 0;
    })();
    // Shared engine — identical math to the server's authoritative recompute at checkout.
    const redeemPlan = computeRedemption(
      requestedRedeem,
      balanceForBaht,
      remainingBillSatang,
      perPointSatang,
      minRedeemPoints
    );
    // maxByBill already carries the `remaining − 1` floor; maxRedeemable also caps by the
    // balance left after reward points.
    const maxRedeemablePoints =
      loyaltyOn && isMember ? Math.min(balanceForBaht, redeemPlan.maxByBillPoints) : 0;
    const effectiveRedeemPoints =
      loyaltyOn && isMember ? redeemPlan.effectiveRedeemPoints : 0;
    const redemptionSatang = loyaltyOn && isMember ? redeemPlan.redemptionSatang : 0;

    // Feed the combined 3-slice bill discount (promo + manual + redemption) to pricing —
    // the IDENTICAL input the server uses, so the on-screen total equals the authoritative
    // recompute. Replaces `application.combinedBill` (which carried only promo + manual).
    const combinedBillSatang =
      application.promoBillDiscountSatang +
      application.manualBillDiscountSatang +
      redemptionSatang;
    const items: PricingItem[] = cart.map((i, idx) => ({
      priceSatang: bahtToSatang(i.product.price),
      qty: i.quantity,
      lineDiscountSatang: application.lines[idx]?.combinedLineDiscountSatang ?? 0,
      // Per-item VAT (per-item-vat program): carry each product's VAT applicability so the
      // on-screen VAT/total matches the server recompute EXACTLY. Consulted by computeTotals
      // only when perItemVat is on; a missing value is treated as VAT-applicable.
      vatable: i.product.vatable,
    }));
    // Per-item VAT flag (per-item-vat program) — a server-read of PER_ITEM_VAT_ENABLED
    // surfaced on the settings the POS fetches at mount. When off (the default), computeTotals
    // charges VAT on every line, so the displayed VAT/total is byte-identical to today.
    const perItemVat = receiptSettings?.perItemVatEnabled === true;
    const totals = computeTotals(
      items,
      { type: "amount", value: combinedBillSatang / 100 },
      perItemVat
    );
    return {
      totals,
      application,
      redemptionSatang,
      effectiveRedeemPoints,
      maxRedeemablePoints,
    };
  }, [
    cart,
    discountDraft,
    discountType,
    activePromos,
    redeemDraft,
    customer,
    receiptSettings,
    rewardCountByProduct,
    rewardPointsTotal,
  ]);

  // Total promotion savings on this bill (Σ line promos + bill promo) — informational,
  // shown in the payment modal under the total due.
  const promoSavingsSatang = useMemo(
    () =>
      application.lines.reduce((s, l) => s + l.promoDiscountSatang, 0) +
      application.promoBillDiscountSatang,
    [application]
  );

  // Nearest UNMET spend-&-save (BILL_THRESHOLD) promo (promotions program, Phase 7):
  // among threshold promos whose min the current subtotal has not reached, pick the
  // closest and surface "buy ฿X more → save Y". Null when a threshold promo is already
  // applied (it shows as a discount row instead) or none is unmet.
  const thresholdHint = useMemo(() => {
    if (application.billPromo) return null;
    const subtotal = application.subtotalSatang;
    let nearest: { missingSatang: number; rewardLabel: string } | null = null;
    for (const promo of activePromos) {
      if (promo.type !== "BILL_THRESHOLD") continue;
      const min = promo.minSubtotalSatang;
      if (typeof min !== "number" || !Number.isFinite(min) || min <= 0) continue;
      const missingSatang = min - subtotal;
      if (missingSatang <= 0) continue; // already met (would have applied) → skip
      if (nearest === null || missingSatang < nearest.missingSatang) {
        nearest = { missingSatang, rewardLabel: promoRewardLabel(promo) };
      }
    }
    return nearest;
  }, [application, activePromos]);

  // Reconcile selected rewards against the cart (loyalty program, Phase 3B). If the cashier
  // manually removes / reduces a product line below its redeemed-reward count (removeLine,
  // the qty stepper, etc.), drop the now-uncovered rewards so a redeemed reward always has a
  // paid-for-or-free unit backing it in the cart — the SAME "cart qty ≥ reward count per
  // product" rule the server enforces. Prune-only (never adds) and returns the SAME array ref
  // when nothing changed, so it can depend on `cart` without looping.
  useEffect(() => {
    setSelectedRewards((prev) => {
      if (prev.length === 0) return prev;
      const cartQty = new Map<string, number>();
      for (const i of cart) cartQty.set(i.product.id, i.quantity);
      const usedByProduct = new Map<string, number>();
      const kept = prev.filter((r) => {
        const used = usedByProduct.get(r.productId) ?? 0;
        const qty = cartQty.get(r.productId) ?? 0;
        if (used < qty) {
          usedByProduct.set(r.productId, used + 1);
          return true;
        }
        return false;
      });
      return kept.length === prev.length ? prev : kept;
    });
  }, [cart]);

  // ---- cart actions ----
  // useCallback keeps addToCart referentially stable across renders so the
  // React.memo'd ProductCard only re-renders when its own props change — not on
  // every keystroke. setCart is a stable setter (no dep needed); showToast is a
  // stable useCallback from ToastProvider.
  const addToCart = useCallback((product: Product) => {
    const stock = effectiveStock(product);
    // Item A.1 — out of stock: never add, and tell the cashier why (the scan path
    // reaches here too, where the card's disabled state does not apply).
    if (stock <= 0) {
      showToast(`สินค้าหมด ไม่สามารถขายได้ · ${product.name}`);
      return;
    }
    // Item A.2 — can't exceed the displayed stock: read the CURRENT cart qty via the
    // latest-cart ref (keeps this callback stable) and reject the increment with a
    // clamp message. The server still guards authoritatively at checkout.
    const existing = cartRef.current.find((i) => i.product.id === product.id);
    if (existing && existing.quantity >= stock) {
      showToast(`จำนวนไม่พอขาย · เหลือ ${stock} ชิ้น`);
      return;
    }
    setCart((prev) => {
      const inCart = prev.find((i) => i.product.id === product.id);
      if (inCart) {
        return prev.map((i) =>
          i.product.id === product.id ? { ...i, quantity: i.quantity + 1 } : i
        );
      }
      return [...prev, { product, quantity: 1, lineDiscountSatang: 0 }];
    });
    showToast(`เพิ่ม ${product.name} แล้ว`);
  }, [showToast]);

  function incLine(productId: string) {
    // Item A.2 — clamp the cart's + button at the displayed stock. This is a plain
    // (non-memoized) function, so reading `cart`/`products` directly is safe. Prefer the
    // live grid product (SSE-patched, warehouse-scoped) over the cart's captured product
    // so the ceiling reflects the freshest displayed stock.
    const line = cart.find((i) => i.product.id === productId);
    if (line) {
      const live = products.find((p) => p.id === productId);
      const stock = effectiveStock(live ?? line.product);
      if (line.quantity >= stock) {
        showToast(`จำนวนไม่พอขาย · เหลือ ${stock} ชิ้น`);
        return;
      }
    }
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
    // Reset the points redemption (loyalty program, Phase 2) — a new/abandoned bill
    // starts with no redemption (the customer is cleared above too).
    setRedeemDraft("");
    // Reset reward redemption (loyalty program, Phase 3B) — a new/abandoned bill starts with
    // no rewards (the customer + cart are cleared above, so the free units go with them).
    setSelectedRewards([]);
    // Drop the idempotency key — the bill is gone, so the NEXT checkout is a new
    // sale and must mint a fresh key (a successful checkout calls clearBill, as do
    // cancel/hold). Without this, the next sale would replay the just-completed
    // order (200) and never actually record the new sale.
    idemKeyRef.current = null;
  }

  // ---- points redemption input (loyalty program, Phase 2) ----
  // Keep only digits and CLAMP to the member's redeemable max (min(balance, maxByBill))
  // so the cashier can never request more than the balance or the bill can absorb —
  // which also guarantees the previewed points map EXACTLY to their value (no fractional
  // point). Empty → cleared. `maxRedeemablePoints` comes from the totals memo and does
  // NOT depend on `redeemDraft`, so this clamp can never feed back into itself.
  function onRedeemChange(value: string) {
    const digits = value.replace(/[^\d]/g, "");
    if (digits === "") {
      setRedeemDraft("");
      return;
    }
    const clamped = Math.min(
      Math.max(Math.trunc(Number(digits)), 0),
      maxRedeemablePoints
    );
    setRedeemDraft(clamped > 0 ? String(clamped) : "");
  }

  // ---- reward redemption handlers (loyalty program, Phase 3B) ----
  // The ids currently selected (each reward is redeemable at most once per bill).
  const selectedRewardIds = useMemo(
    () => new Set(selectedRewards.map((r) => r.id)),
    [selectedRewards]
  );
  // Points already committed on this bill = baht redemption + selected rewards. Drives the
  // picker's affordability gate + the payment modal's combined-points display.
  const committedPoints = effectiveRedeemPoints + rewardPointsTotal;
  // Raw available stock per reward product (for the picker's "สินค้าหมด" note). Small set
  // (a handful of rewards), so the per-reward product lookup is cheap; the toggle handler
  // does the authoritative "enough stock to add one more free unit" check.
  const rewardStockByProductId = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rewards) {
      const p = products.find((x) => x.id === r.productId);
      m.set(r.productId, p ? effectiveStock(p) : 0);
    }
    return m;
  }, [rewards, products]);

  // Toggle a reward on/off. ADD: verify a live, in-stock product + enough points left, then
  // add 1 free unit to the cart (reuse addToCart), CLEAR any manual discount on that line (a
  // reward's free unit must not stack a manual discount — the server clamps it, the UI never
  // offers it), and record the reward. REMOVE: drop one selection + remove its free cart
  // unit. Server re-validates everything at checkout, so this is preview/convenience only.
  function toggleReward(reward: RewardDTO) {
    if (selectedRewardIds.has(reward.id)) {
      setSelectedRewards((prev) => {
        const idx = prev.findIndex((r) => r.id === reward.id);
        if (idx === -1) return prev;
        return prev.filter((_, i) => i !== idx);
      });
      // Remove the free unit this reward added.
      decLine(reward.productId);
      return;
    }
    const product = products.find((p) => p.id === reward.productId);
    if (!product || reward.product === null) {
      showToast("ไม่พบสินค้าของรางวัลนี้");
      return;
    }
    // FIX A — a reward can't stack on a product that already has an active line-level
    // promotion (the server rejects it with REWARD_PROMO_CONFLICT). Refuse the add here
    // so the cashier is never left with a selection the checkout would 422.
    if (linePromoProductIds.has(reward.productId)) {
      showToast("สินค้านี้มีโปรโมชันอยู่แล้ว แลกของรางวัลไม่ได้");
      return;
    }
    const stock = effectiveStock(product);
    const inCartQty = cart.find((i) => i.product.id === product.id)?.quantity ?? 0;
    if (inCartQty >= stock) {
      showToast(`สินค้าของรางวัลไม่พอ · เหลือ ${stock} ชิ้น`);
      return;
    }
    const balance = customer?.pointsBalance ?? 0;
    if (reward.pointsCost > Math.max(balance - committedPoints, 0)) {
      showToast("แต้มสะสมไม่เพียงพอสำหรับของรางวัลนี้");
      return;
    }
    addToCart(product);
    // A reward line carries no manual discount (see the CartLine + server clamp).
    setLineDiscount(product.id, 0);
    setSelectedRewards((prev) => [...prev, reward]);
  }

  // Open the reward picker (member + loyaltyEnabled only, gated at the call site).
  function openRewardPicker() {
    setRewardPickerOpen(true);
  }

  // ---- silent-print onboarding handlers (Plan A) ----
  // Temporary close (X / backdrop): no flag written, so the guide re-appears on the
  // next page load unless the operator dismisses it or opens via the kiosk shortcut.
  function handleOnboardingClose() {
    setOnboardingOpen(false);
  }

  // Permanent dismiss ("ตั้งค่าเสร็จแล้ว"): persist the dismissed flag so the guide
  // never re-appears on this browser.
  function handleOnboardingDismiss() {
    markDismissed();
    setOnboardingOpen(false);
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
    // Switching customer invalidates any in-progress redemption (it was scoped to the
    // previous member's balance) — reset it (loyalty program, Phase 2 + 3B).
    setRedeemDraft("");
    setSelectedRewards([]);
    setCustPickerOpen(false);
  }

  // Walk-in clears the selected customer; a walk-in can't request a tax invoice,
  // so the tax flag is dropped too.
  function pickWalkIn() {
    setCustomer(null);
    setTaxRequested(false);
    // A walk-in has no points to redeem — reset it (loyalty program, Phase 2 + 3B).
    setRedeemDraft("");
    setSelectedRewards([]);
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
    const payload: Record<string, string | boolean> = { name: input.name };
    // Membership flag (loyalty program, Phase 1A) — always sent; the server enrolls /
    // requires a phone accordingly. On create, a member's phone is added below (it is
    // non-empty by the form's member-phone rule).
    payload.isMember = input.isMember;
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
            : code === "MEMBER_PHONE_TAKEN"
              ? "เบอร์นี้มีสมาชิกใช้แล้ว"
              : code === "MEMBER_PHONE_REQUIRED"
                ? "สมาชิกต้องระบุเบอร์โทร"
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
    // Loyalty (loyalty program, Phase 1A): the snapshot customer may predate the
    // isMember/pointsBalance fields, so default them to a valid CustomerDTO on resume
    // (chip/checkout use of membership on a resumed bill is Phase 1B).
    const snapCustomer = bill.cartJson.customer;
    setCustomer(
      snapCustomer
        ? {
            ...snapCustomer,
            isMember: snapCustomer.isMember ?? false,
            pointsBalance: snapCustomer.pointsBalance ?? 0,
          }
        : null
    );
    setTaxRequested(bill.taxRequested);
    // A resumed bill starts with no redemption (park did not snapshot redeem points/rewards,
    // and the member's balance may have changed since) — the cashier re-redeems if they want
    // (loyalty program, Phase 2 + 3B).
    setRedeemDraft("");
    setSelectedRewards([]);
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
  // on re-open. cashReceived/reference are always cleared on close now
  // (closePayment, owner request), so a re-opened split starts with an empty
  // cash-received either way. (The success-confirm path fully resets all state.)
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
    // else: a preserved split exists (closed via X) — leave payLines intact
    // (cash/ref were already cleared on close by closePayment).
    setPayError("");
    setPayOpen(true);
  }

  // Close (X / Escape / backdrop): mark closed and PRESERVE the split payLines for
  // re-open, but CLEAR the cash-received + reference fields (owner request). A
  // cashier often closes payment to add more items to a bigger bill; a stale
  // "รับเงินสด" (e.g. ฿100 on what is now a larger total) must never linger on
  // re-open. This is the single choke point for every non-confirm close, so all
  // close paths are covered here. The confirm/success path resets independently.
  function closePayment() {
    setPayOpen(false);
    setCashReceived("");
    setReference("");
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
    // Bound the order POST with the SAME AbortController+setTimeout pattern as
    // the agent detection in src/lib/print/index.ts (no AbortSignal.timeout —
    // pattern consistency + TS-lib safety). The timer is ALWAYS cleared in the
    // finally below, alongside the existing setSubmitting(false).
    const postController =
      typeof AbortController !== "undefined" ? new AbortController() : null;
    const postTimer =
      postController !== null && typeof setTimeout !== "undefined"
        ? setTimeout(() => postController.abort(), ORDER_POST_TIMEOUT_MS)
        : null;
    try {
      const trimmedRef = reference.trim();
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: postController?.signal,
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
          // Points redemption (loyalty program, Phase 2): the whole points to spend as a
          // discount. NO money is sent — the server recomputes the ฿ value + folds it in
          // as the third bill-discount slice, and re-validates the balance atomically.
          // Sent only when > 0 (input already clamped to the redeemable max). Omitted for
          // a non-member / no-redeem bill (byte-identical to before).
          ...(effectiveRedeemPoints > 0
            ? { redeemPoints: effectiveRedeemPoints }
            : {}),
          // Reward redemption (loyalty program, Phase 3B): the ids of the rewards being
          // redeemed for a free product unit each. NO points/money are sent — the server
          // re-loads each reward, resolves the free-unit value, validates it is in the cart,
          // and spends Σ pointsCost COMBINED with the baht redemption atomically. Sent only
          // when non-empty (omitted for a no-reward bill — byte-identical to before).
          ...(selectedRewards.length > 0
            ? { redeemRewardIds: selectedRewards.map((r) => r.id) }
            : {}),
          // Per-attempt idempotency key (Sub-phase C) — same key across retries
          // of THIS submission; the server replays the existing order on a dupe.
          idempotencyKey,
        }),
      });
      if (!res.ok) {
        let msg = "ชำระเงินไม่สำเร็จ ลองใหม่อีกครั้ง";
        let code = "";
        try {
          const data = await res.json();
          if (data?.error) msg = data.error;
          if (typeof data?.code === "string") code = data.code;
        } catch {
          /* keep default message */
        }
        // Stale-promo guard (promotions program, Phase 7): the server rejects with
        // PAYMENT_MISMATCH when its authoritative total no longer matches the client's
        // preview — which happens when a promotion expired/changed mid-bill. Refetch the
        // effective promos so the totals memo recomputes against the same set the server
        // now uses, and tell the cashier to re-check before re-confirming. We keep the
        // banner path/shape and only swap the message for this code (other 422s keep
        // their server message untouched).
        if (code === "PAYMENT_MISMATCH") {
          loadPromotions();
          // Reset the points redemption preview (loyalty program, Phase 2): a stale
          // redeem preview is a possible cause of the mismatch (a promo shifted the
          // remaining bill, or another terminal spent the member's points). Clearing it
          // recomputes the total to 0 redemption so the cashier re-enters against the
          // fresh figures. The member's balance is re-validated ATOMICALLY at checkout
          // (the in-tx guard), so no separate balance refetch is required for safety.
          setRedeemDraft("");
          // Reward selections too (loyalty program, Phase 3B): a reward may have been turned
          // off, or the member's balance changed, so clear the redeemed rewards + refetch the
          // active set. The free cart units remain (now billed) so the cashier re-checks + re-
          // redeems against the fresh figures; the server re-validates every reward anyway.
          setSelectedRewards([]);
          loadRewards();
          msg = "โปรโมชันหรือแต้มมีการเปลี่ยนแปลง ยอดถูกคำนวณใหม่ กรุณาตรวจสอบ";
        }
        // Reward-only ฿0 backstop (loyalty program, Phase 3B — FIX C): the client already
        // blocks confirm when a reward is redeemed on a ฿0 bill, but if the server's guard
        // (REWARD_NEEDS_PURCHASE) — or a raw payment BAD_AMOUNT on a reward bill — is ever
        // reached, swap the raw code for the friendly, actionable reward message so the
        // cashier is told to add a payable item rather than seeing "Invalid payment amount".
        if (
          code === "REWARD_NEEDS_PURCHASE" ||
          (code === "BAD_AMOUNT" && selectedRewards.length > 0)
        ) {
          msg = "ต้องมีสินค้าที่ต้องชำระอย่างน้อย 1 รายการเพื่อแลกของรางวัล";
        }
        setPayError(msg);
        return;
      }
      const order = (await res.json()) as OrderDTO;
      // Loyalty EARN feedback (loyalty program, Phase 1B): capture the member + the
      // points just earned NOW — BEFORE clearBill() below nulls the selected customer
      // — so the success toast can confirm the accrual + the new (optimistic) balance.
      // The server already incremented the balance atomically inside the checkout tx,
      // so `pointsEarned` on the response is authoritative; adding it to the member's
      // pre-sale balance reproduces the server value with NO extra fetch.
      const earnedPoints = order.pointsEarned ?? 0;
      // Loyalty REDEEM feedback (loyalty program, Phase 2): the points the server SPENT on
      // this bill (authoritative — the in-tx atomic decrement already applied). Folded into
      // the same success toast + the optimistic new-balance math below.
      const redeemedPoints = order.pointsRedeemed ?? 0;
      const earnMember = customer?.isMember ? customer : null;
      // Optimistic display-only stock decrement (pos-instant-stock): subtract each
      // just-sold line's quantity from that product's `stock` in local state so the
      // grid's คงเหลือ/หมด badge updates instantly. Sold quantities are captured
      // from the current `cart` HERE, BEFORE clearBill() empties it below. This is
      // display-only — the authoritative per-warehouse stock reconciles on the next
      // /api/products fetch (page reload / navigation) after the 60s auto-sync; that
      // eventual consistency is acceptable, instant feedback is the goal.
      const soldById = new Map<string, number>();
      for (const i of cart) {
        soldById.set(i.product.id, (soldById.get(i.product.id) ?? 0) + i.quantity);
      }
      setProducts((prev) =>
        prev.map((p) => {
          const soldQty = soldById.get(p.id) ?? 0;
          return soldQty > 0
            ? {
                ...p,
                stock: Math.max(
                  0,
                  (typeof p.stock === "number" ? p.stock : 0) - soldQty
                ),
              }
            : p;
        })
      );
      // Success (pos-autoprint-receipt): close payment, stash the order, clear the
      // bill, then print + return to a fresh sale. PaymentModal is closed HERE so
      // only the receipt's portal is present at print time. The cart/payment state
      // is cleared straight away = a new sale. The receipt-overlay mount is
      // deferred to the print branch below so it can be gated by a FRESH detection
      // (see the print-agent-first-sale-race note) rather than the stale
      // `agentAvailable` state.
      setPayOpen(false);
      setReceiptOrder(order);
      setPayLines([]);
      setCashReceived("");
      setReference("");
      setPayError("");
      clearBill();
      // The only on-screen confirmation now that the receipt page is gone. Honest
      // for BOTH paths (agent silent-print or browser dialog / kiosk print). For a
      // member sale that earned points, fold the loyalty accrual + new balance into
      // this SAME single toast (loyalty program, Phase 1B) — showToast replaces the
      // prior message, so one combined pill preserves both the payment/print
      // confirmation and the points feedback.
      if (earnMember && (earnedPoints > 0 || redeemedPoints > 0)) {
        // New balance = pre-sale balance − redeemed + earned. The server applied the SPEND
        // (REDEEM) then the accrual (EARN) atomically in the checkout tx, so reproducing
        // both deltas off the captured pre-sale balance matches the server with no refetch.
        const newBalance =
          earnMember.pointsBalance - redeemedPoints + earnedPoints;
        const parts = ["ชำระเงินสำเร็จ"];
        if (redeemedPoints > 0) parts.push(`ใช้ ${redeemedPoints} แต้ม`);
        if (earnedPoints > 0) parts.push(`ได้รับ ${earnedPoints} แต้ม`);
        parts.push(`คงเหลือ ${newBalance} แต้ม`);
        showToast(parts.join(" · "));
      } else {
        showToast("ชำระเงินสำเร็จ · กำลังพิมพ์ใบเสร็จ");
      }
      // Return to a fresh sale once the print settles. Fire-and-forget-safe: the
      // sale is already recorded, so a cancelled/failed/suppressed print still
      // settles → reset. The reset runs on BOTH resolve AND reject (same handler,
      // ES2015-safe, no Promise.finally) so a failed/absent/hung print never
      // leaves the receipt overlays stuck. It clears BOTH overlays so either path
      // resets.
      const backToNewSale = () => {
        setAutoPrintOpen(false);
        setCaptureOpen(false);
        setReceiptOrder(null);
        // Refetch effective promotions now the sale has settled (promotions program,
        // Phase 7): a promo may have expired/started between bills, so the next sale
        // previews the current set. Best-effort — the server recompute stays authoritative.
        loadPromotions();
        // Refetch active rewards too (loyalty program, Phase 3B) — a reward may have been
        // created/toggled between bills. Best-effort; the server re-validates at checkout.
        loadRewards();
        // Scanner flow (owner request): put the caret back in the search box
        // the moment the sale settles so the next customer's first barcode
        // fires straight into it — no mouse touch. rAF so it runs AFTER the
        // closing modal's own focus restoration.
        requestAnimationFrame(() => searchRef.current?.focus());
      };
      // print-agent-first-sale-race fix: decide the print backend from a FRESH,
      // AWAITED detectPrintAgent({ fresh: true }) at PRINT TIME — NOT from the
      // `agentAvailable` React state. That state is populated by the mount effect
      // ~1500ms after load, so a checkout in the first ~1.5s after opening the
      // POS window would read it as `false` and wrongly take the browser
      // window.print() fallback (which hangs on the shop's fontless printer)
      // even though the agent IS running. `fresh: true` re-probes /health NOW
      // (bounded ~1500ms) instead of trusting the mount-time cache, so an agent
      // started or stopped AFTER page load is also picked up; the re-probe
      // replaces the module cache so later reads see this latest result.
      // detectPrintAgent NEVER rejects (fail-open false), so this await can only
      // resolve — keeping the branch fully fail-open. `agentAvailable` still
      // drives the onboarding gate only.
      const isAgent = await detectPrintAgent({ fresh: true });
      if (isAgent) {
        // AGENT IMAGE path (pos-receipt-image): mount the OFF-SCREEN, renderable
        // `.print-receipt` DOM (captureMode — html2canvas needs a NON-display:none
        // element), rasterize it to a PNG in the browser, and POST it to the
        // agent's /print-image — Thai always prints correctly (raster, no printer
        // font). captureAndPrintReceiptImage rAF-waits for the paper to mount, so
        // setting captureOpen immediately before it is enough. Fully fail-open: a
        // failed render or dead agent still resolves → backToNewSale.
        setCaptureOpen(true);
        // Watchdog: if the capture chain silently PENDS (a stalled await that
        // slipped past its per-step caps), force the reset anyway — the sale is
        // recorded, only the receipt is lost. Cleared when the chain settles.
        const printWatchdog = setTimeout(backToNewSale, PRINT_WATCHDOG_MS);
        const settlePrint = (printed: boolean) => {
          clearTimeout(printWatchdog);
          if (!printed) {
            // Honest failure signal instead of an eternal "กำลังพิมพ์ใบเสร็จ".
            showToast("พิมพ์ใบเสร็จไม่สำเร็จ — ตรวจสอบเครื่องพิมพ์ แล้วขายต่อได้เลย");
          }
          backToNewSale();
        };
        void captureAndPrintReceiptImage().then(settlePrint, () =>
          settlePrint(false)
        );
      } else {
        console.info("[krs-print] fallback: browser window.print path");
        // BROWSER fallback (unchanged behavior): mount the screen-hidden
        // `.print-receipt` paper (<ReceiptModal open={autoPrintOpen} autoPrint/>),
        // then resolveReceiptPrintService() returns the BrowserPrintService here
        // (agent absent), which rAF-waits that paper and drives
        // printReceiptWithSize → window.print(), resolving on afterprint / 5s
        // fallback. The TEXT PrintAgentService remains available via
        // resolveReceiptPrintService() for back-compat, but the POS agent path now
        // prints via the IMAGE above.
        setAutoPrintOpen(true);
        void resolveReceiptPrintService()
          .then((svc) =>
            svc.printReceipt({
              order,
              seller: receiptSettings,
              sizeSettings: receiptSettings,
            })
          )
          .then(backToNewSale, backToNewSale);
      }
    } catch (err) {
      // Abort (our 30s bound fired) = the outcome is UNKNOWN — the order may or
      // may not have been recorded. The bill AND idemKeyRef stay UNTOUCHED on
      // this path (only the success path above calls clearBill), so the
      // cashier's retry replays the SAME idempotency key and the server
      // collapses a duplicate POST to the one existing Order — no double bill.
      const isAbort =
        (err instanceof DOMException || err instanceof Error) &&
        err.name === "AbortError";
      setPayError(
        isAbort
          ? "การเชื่อมต่อช้าผิดปกติ ยังไม่ยืนยันว่าบันทึกสำเร็จ — กดยืนยันอีกครั้งได้เลย (ระบบกันบิลซ้ำอัตโนมัติ)"
          : "ชำระเงินไม่สำเร็จ ลองใหม่อีกครั้ง"
      );
    } finally {
      if (postTimer !== null) clearTimeout(postTimer);
      setSubmitting(false);
    }
  }

  // ---- auto-print receipt (pos-autoprint-receipt) ----
  // The auto-print mechanism lives behind the swappable ReceiptPrintService
  // (see src/lib/print). On checkout success, confirmPayment awaits a FRESH
  // detectPrintAgent({ fresh: true }) re-probe AT PRINT TIME (Plan B) — not the
  // mount-time `agentAvailable` state (print-agent-first-sale-race) — and branches:
  //   • agent present → the IMAGE path (captureAndPrintReceiptImage) rasterizes
  //     the OFF-SCREEN `.print-receipt` DOM (ReceiptModal open={captureOpen}
  //     captureMode) to a PNG and POSTs it to the localhost /print-image — silent,
  //     Thai-correct raster, NO window.print() dialog.
  //   • agent absent  → BrowserPrintService rAF-waits the screen-hidden
  //     `.print-receipt` paper (ReceiptModal open={autoPrintOpen}), prints via
  //     printReceiptWithSize, and resolves on afterprint (5s fallback).
  // Either way the sale resets to a fresh bill once the print settles (resolve or
  // reject). The former inline rAF/afterprint effect lives in BrowserPrintService.

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
                    promo={promoBadgeByProductId.get(p.id) ?? null}
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
        <div className="flex flex-col gap-2.5 border-b p-[18px]" style={{ borderColor: "var(--line)" }}>
          <div className="flex items-center gap-3">
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
            {/* Loyalty member badge (loyalty program, Phase 1B) — gold/amber accent,
                distinct from the blue tax badge + mint promo, showing the live points
                balance while the member is attached to the bill. */}
            {customer?.isMember && (
              <span
                className="flex-shrink-0 rounded-md px-2 py-[3px] text-[10px] font-semibold"
                style={{
                  background: "#FFFBEB",
                  color: "#B45309",
                  border: "1px solid #FCD34D",
                }}
              >
                สมาชิก · {customer.pointsBalance} แต้ม
              </span>
            )}
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

          {/* "แลกของรางวัล" affordance (loyalty program, Phase 3B) — gold/amber, shown only
              for an enrolled member on a loyalty-ON store. Opens the reward picker; each
              selected reward adds a free cart unit + a gold chip on its line. */}
          {receiptSettings?.loyaltyEnabled === true && customer?.isMember === true && (
            <button
              type="button"
              onClick={openRewardPicker}
              aria-label="แลกของรางวัล"
              className="flex items-center justify-between gap-2 rounded-[14px] border px-3.5 py-2.5 text-left transition hover:brightness-[.98]"
              style={{ background: "#FFFBEB", borderColor: "#FCD34D", color: "#B45309" }}
            >
              <span className="flex items-center gap-2 text-[12.5px] font-semibold">
                <Gift size={16} strokeWidth={2} />
                แลกของรางวัล
                {selectedRewards.length > 0
                  ? ` · เลือกไว้ ${selectedRewards.length} ชิ้น`
                  : ""}
              </span>
              <ChevronRight size={16} strokeWidth={2} className="flex-shrink-0" />
            </button>
          )}
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
            cart.map((item, idx) => {
              // The promotion engine returns per-line results in cart order, so
              // application.lines[idx] is this line's promo (null when none applied).
              const linePromo = application.lines[idx]?.promo ?? null;
              return (
                <CartLine
                  key={item.product.id}
                  item={item}
                  lineGrossSatang={
                    bahtToSatang(item.product.price) * item.quantity
                  }
                  appliedPromo={
                    linePromo
                      ? {
                          name: linePromo.promotionName,
                          discountSatang: linePromo.discountSatang,
                        }
                      : null
                  }
                  rewardCount={rewardCountByProduct.get(item.product.id) ?? 0}
                  onInc={incLine}
                  onDec={decLine}
                  onRemove={removeLine}
                  onLineDiscount={setLineDiscount}
                />
              );
            })
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
          promoBillDiscountSatang={application.promoBillDiscountSatang}
          billPromoName={application.billPromo?.promotionName ?? null}
          pointsRedemptionSatang={redemptionSatang}
          thresholdHint={thresholdHint}
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

      {/* Reward picker (loyalty program, Phase 3B) — "แลกของรางวัล". Only the rewards whose
          product is live are offered; the picker gates affordability + stock, and the parent
          `toggleReward` adds/removes the free cart unit + tracks the redeemed id. */}
      <RewardPickerModal
        open={rewardPickerOpen}
        rewards={rewards.filter((r) => r.product !== null)}
        pointsBalance={customer?.pointsBalance ?? 0}
        committedPoints={committedPoints}
        selectedIds={selectedRewardIds}
        stockByProductId={rewardStockByProductId}
        promoProductIds={linePromoProductIds}
        onToggle={toggleReward}
        onClose={() => setRewardPickerOpen(false)}
      />

      {/* Payment modal (Phase 3 + Phase 6a tax toggle) */}
      <PaymentModal
        open={payOpen}
        totalSatang={totals.totalSatang}
        vatSatang={totals.vatSatang}
        itemCount={itemCount}
        promoSavingsSatang={promoSavingsSatang}
        customer={customer}
        taxRequested={taxRequested}
        redeem={
          // Points-redemption control (loyalty program, Phase 2) — shown only for an
          // enrolled member on a loyalty-ON store. The memo above owns all the math; the
          // modal only renders + surfaces the below-min warning. FIX 3: also HIDE the
          // control when the remaining bill can't reach the redeem floor
          // (`maxRedeemablePoints < minRedeemPoints`) — an impossible redemption must never
          // be offered (server mirrors this with POINTS_REDEEM_UNAVAILABLE). A 0 floor
          // (no minimum) never hides the control.
          receiptSettings?.loyaltyEnabled === true &&
          customer?.isMember === true &&
          maxRedeemablePoints >= (receiptSettings.minRedeemPoints ?? 0)
            ? {
                pointsBalance: customer.pointsBalance,
                maxRedeemablePoints,
                minRedeemPoints: receiptSettings.minRedeemPoints ?? 0,
                draft: redeemDraft,
                redemptionSatang,
                effectiveRedeemPoints,
                onChange: onRedeemChange,
                onClear: () => setRedeemDraft(""),
              }
            : null
        }
        rewardCount={selectedRewards.length}
        rewardPoints={rewardPointsTotal}
        redeemOverBalance={
          committedPoints > (customer?.pointsBalance ?? 0)
        }
        rewardZeroTotalBlock={
          selectedRewards.length > 0 && totals.totalSatang <= 0
        }
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

      {/* Receipt (pos-autoprint-receipt): screen-hidden + auto-printed on checkout
          success, then straight back to a new sale — NO visible receipt page and
          no manual print/new-sale clicks. `seller` is the page's mount-fetched
          settings so the printed header is correct on first paint (no fetch race).
          The visible manual actions are unused here (the overlay is display:none),
          so onPrint/onEmail/onNewSale are intentionally omitted. */}
      <ReceiptModal
        open={autoPrintOpen}
        order={receiptOrder}
        autoPrint
        seller={receiptSettings}
      />

      {/* Agent image-print capture (pos-receipt-image): OFF-SCREEN but renderable
          `.print-receipt` DOM (NOT display:none) so html2canvas can rasterize the
          receipt — incl. Thai — to a PNG for the local ESC/POS agent. Mounted only
          on the agent path (captureOpen). Same content as the auto-print receipt. */}
      <ReceiptModal
        open={captureOpen}
        order={receiptOrder}
        captureMode
        seller={receiptSettings}
      />

      {/* Held-bills (พักบิล) list — resume / discard a parked bill */}
      <HeldBillsModal
        open={heldBillsOpen}
        onClose={() => setHeldBillsOpen(false)}
        onResume={resumeBill}
        onDiscard={discardHeldBill}
      />

      {/* Silent-print onboarding (Plan A) — first-run guide + .bat download.
          Suppressed after permanent dismiss or when opened via the kiosk shortcut
          (?kiosk=1). Purely client-side UI; does not touch the checkout/print path. */}
      <SilentPrintOnboardingModal
        open={onboardingOpen}
        onClose={handleOnboardingClose}
        onDismissPermanently={handleOnboardingDismiss}
      />
    </div>
  );
}
