"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ScanBarcode, ShoppingCart, UserRound, AlertCircle } from "lucide-react";
import type { Product, CartItem, CategorySlug, DiscountType } from "@/types";
import { useToast } from "@/components/ToastProvider";
import {
  bahtToSatang,
  computeTotals,
  type PricingItem,
} from "@/lib/pricing";
import { slugForCategoryName } from "@/components/pos/categoryMeta";
import { CategoryPanel, type CategoryChip } from "@/components/pos/CategoryPanel";
import { ProductCard } from "@/components/pos/ProductCard";
import { CartLine } from "@/components/pos/CartLine";
import { TotalsBar } from "@/components/pos/TotalsBar";

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

  const [checkingOut, setCheckingOut] = useState(false);
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

  function cancelBill() {
    if (cart.length === 0) return;
    setCart([]);
    setDiscountDraft("");
    setDiscountType("amount");
    showToast("ยกเลิกบิลแล้ว");
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

  // ---- preserved cash checkout (NOT the Phase 3 payment modal) ----
  async function pay() {
    if (cart.length === 0 || checkingOut) return;
    setCheckingOut(true);
    try {
      // TODO(phase3): server-side inclusive-tax recompute + idempotency key.
      // The pricing here is authoritative client-side for Phase 2; Phase 3 / the
      // production-readiness program harden the server contract.
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: cart.map((i) => ({
            productId: i.product.id,
            quantity: i.quantity,
          })),
          paymentType: "CASH",
          amountPaid: totals.totalSatang / 100,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const order = await res.json();
      showToast(`ขายสำเร็จ · บิล ${order.orderNumber ?? ""}`.trim());
      setCart([]);
      setDiscountDraft("");
      setDiscountType("amount");
    } catch {
      showToast("ชำระเงินไม่สำเร็จ ลองใหม่อีกครั้ง");
    } finally {
      setCheckingOut(false);
    }
  }

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
      {/* Workspace: header + command + category panel + product grid */}
      <main className="flex min-w-0 flex-1 flex-col gap-3.5 p-[18px] pl-5">
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

        {/* Category panel + product grid */}
        <section className="grid min-h-0 flex-1" style={{ gridTemplateColumns: "168px minmax(0,1fr)", gap: 14 }}>
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
      </main>

      {/* Cart panel (408px) */}
      <aside
        className="flex w-[408px] flex-shrink-0 flex-col border-l bg-white"
        style={{
          borderColor: "var(--line)",
          boxShadow: "-16px 0 36px rgba(21,38,64,.06)",
        }}
      >
        <div className="flex items-center gap-3 border-b p-[18px]" style={{ borderColor: "var(--line)" }}>
          <div
            className="flex h-16 flex-1 items-center gap-3 rounded-[18px] border border-dashed px-3.5"
            style={{ borderColor: "var(--line-strong)", background: "#fbfdff" }}
          >
            <span
              className="grid h-[38px] w-[38px] place-items-center rounded-[14px]"
              style={{ background: "#eef4ff", color: "#2563eb" }}
            >
              <UserRound size={18} strokeWidth={2} />
            </span>
            <div className="min-w-0">
              <strong className="block text-[13px]">ลูกค้าทั่วไป · Walk-in</strong>
              <span className="block text-[11px]" style={{ color: "var(--muted)" }}>
                สมาชิก / ใบกำกับภาษี (เร็วๆ นี้)
              </span>
            </div>
          </div>
        </div>

        {/* Cart list */}
        <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-auto p-[18px]">
          {cart.length === 0 ? (
            <div className="grid h-full place-items-center text-center" style={{ color: "#98a2b3" }}>
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
          onCancelBill={cancelBill}
          onPay={pay}
          payDisabled={cart.length === 0 || checkingOut}
          checkingOut={checkingOut}
        />
      </aside>
    </div>
  );
}
