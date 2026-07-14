"use client";

import { useEffect, useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { money } from "@/lib/money";
import type { Product } from "@/types";

type PromotionProductPickerProps = {
  /** Currently-selected product ids (the `productIds` payload). */
  value: string[];
  /** Called with the next selection whenever a row is toggled / a pill removed. */
  onChange: (ids: string[]) => void;
  /**
   * Lifts the fetched product list to the parent so it can price-check the
   * selection (the FIXED_PRICE "special price ≥ normal price" amber warning) —
   * the picker owns the fetch, the parent reuses the result.
   */
  onProductsLoaded?: (products: Product[]) => void;
};

type FetchState = "idle" | "loading" | "ready" | "error";

/**
 * Inline (NOT nested-modal) multi-select for scoping a promotion to specific
 * products (promotions program, Phase 5). Fetches /api/products on mount (the
 * CustomerPickerModal fetch pattern), filters name/SKU client-side, and renders a
 * scrollable checkbox list. The current selection is shown ABOVE as removable
 * mint pills with a running count. Promotion accent = mint (var(--brand)); the
 * blue chrome stays reserved for manual discounts.
 */
export function PromotionProductPicker({
  value,
  onChange,
  onProductsLoaded,
}: PromotionProductPickerProps) {
  const [products, setProducts] = useState<Product[]>([]);
  const [state, setState] = useState<FetchState>("idle");
  const [query, setQuery] = useState("");

  // Fetch the product catalog once on mount (this section only mounts when a
  // scoped promotion type is selected). AbortController guards a fast unmount
  // (e.g. the cashier switching the promo type before the fetch resolves).
  useEffect(() => {
    const ctrl = new AbortController();
    setState("loading");
    fetch("/api/products", { signal: ctrl.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: Product[]) => {
        if (ctrl.signal.aborted) return;
        const list = Array.isArray(data) ? data : [];
        setProducts(list);
        setState("ready");
        onProductsLoaded?.(list);
      })
      .catch((err) => {
        if (err?.name === "AbortError" || ctrl.signal.aborted) return;
        setState("error");
      });
    return () => ctrl.abort();
    // onProductsLoaded is a stable callback from the parent; fetch runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return products;
    return products.filter(
      (p) =>
        p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)
    );
  }, [products, q]);

  // Selected product objects (for the pills) — resolved from the fetched list so
  // pills show the real name once products load.
  const selected = useMemo(
    () => products.filter((p) => value.includes(p.id)),
    [products, value]
  );

  function toggle(id: string) {
    if (value.includes(id)) {
      onChange(value.filter((v) => v !== id));
    } else {
      onChange([...value, id]);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[12.5px] font-semibold">
          สินค้าที่ร่วมรายการ · Products
        </span>
        <span className="text-[11.5px]" style={{ color: "var(--muted)" }}>
          เลือกแล้ว {value.length} รายการ
        </span>
      </div>

      {/* Selected pills (mint, removable) */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((p) => (
            <span
              key={p.id}
              className="inline-flex items-center gap-1 rounded-full py-1 pl-2.5 pr-1 text-[12px] font-semibold"
              style={{ background: "var(--mint)", color: "var(--brand-2)" }}
            >
              {p.name}
              <button
                type="button"
                onClick={() => toggle(p.id)}
                aria-label={`นำ ${p.name} ออก`}
                className="grid h-5 w-5 place-items-center rounded-full"
                style={{ color: "var(--brand-2)" }}
              >
                <X size={13} strokeWidth={2.4} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Search */}
      <label
        className="flex h-10 items-center gap-2 rounded-[12px] border bg-white px-3"
        style={{ borderColor: "var(--line)" }}
      >
        <Search size={16} strokeWidth={2} color="#667085" />
        <span className="sr-only">ค้นหาสินค้า ชื่อ หรือ SKU</span>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="ค้นหาสินค้า ชื่อ / SKU"
          autoComplete="off"
          aria-label="ค้นหาสินค้า ชื่อ หรือ SKU"
          className="min-w-0 flex-1 border-0 text-[13px] outline-none"
          style={{ color: "var(--ink)" }}
        />
      </label>

      {/* Checkbox list */}
      <div
        className="max-h-[220px] overflow-y-auto rounded-[12px] border"
        style={{ borderColor: "var(--line)" }}
      >
        {state === "loading" ? (
          <div
            className="py-8 text-center text-[12.5px]"
            style={{ color: "var(--soft)" }}
          >
            กำลังโหลดสินค้า…
          </div>
        ) : state === "error" ? (
          <div className="py-8 text-center text-[12.5px]" style={{ color: "#dc2626" }}>
            โหลดสินค้าไม่สำเร็จ
          </div>
        ) : filtered.length === 0 ? (
          <div
            className="py-8 text-center text-[12.5px]"
            style={{ color: "var(--soft)" }}
          >
            ไม่พบสินค้า · No matching products
          </div>
        ) : (
          filtered.map((p) => {
            const checked = value.includes(p.id);
            return (
              <label
                key={p.id}
                className="flex cursor-pointer items-center gap-3 border-b px-3 py-2.5 last:border-b-0"
                style={{ borderColor: "var(--line)" }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(p.id)}
                  className="h-4 w-4 flex-shrink-0 accent-[var(--brand)]"
                />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                  {p.name}
                </span>
                <span
                  className="mono flex-shrink-0 text-[11.5px]"
                  style={{ color: "var(--muted)" }}
                >
                  {p.sku}
                </span>
                <span className="mono flex-shrink-0 text-[12px] font-semibold">
                  {money(Number(p.price))}
                </span>
              </label>
            );
          })
        )}
      </div>
    </div>
  );
}
