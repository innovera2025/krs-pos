"use client";

import { useEffect, useMemo, useState } from "react";
import { Search, Check } from "lucide-react";
import { money } from "@/lib/money";
import { GOLD } from "@/components/members/memberMeta";
import type { Product } from "@/types";

type RewardProductPickerProps = {
  /** Currently-selected product id (the reward's `productId`), or "" for none. */
  value: string;
  /** Called with the next single selection when a row is picked. */
  onChange: (id: string) => void;
  /**
   * Lifts the fetched product list to the parent so it can resolve the selected
   * product's name/price for the live preview — the picker owns the fetch, the parent
   * reuses the result (mirrors PromotionProductPicker.onProductsLoaded).
   */
  onProductsLoaded?: (products: Product[]) => void;
};

type FetchState = "idle" | "loading" | "ready" | "error";

/**
 * Inline SINGLE-select product picker for a reward's free product (loyalty program,
 * Phase 3A). Fetches /api/products on mount (the PromotionProductPicker fetch pattern),
 * filters name/SKU client-side, and renders a scrollable radio list — a reward gives away
 * exactly ONE product, so this is single-select (unlike the promotion multi-select).
 * Selection accent = GOLD (loyalty), distinct from the promotion mint picker.
 */
export function RewardProductPicker({
  value,
  onChange,
  onProductsLoaded,
}: RewardProductPickerProps) {
  const [products, setProducts] = useState<Product[]>([]);
  const [state, setState] = useState<FetchState>("idle");
  const [query, setQuery] = useState("");

  // Fetch the product catalog once on mount. AbortController guards a fast unmount.
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
      (p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)
    );
  }, [products, q]);

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[12.5px] font-semibold">
        สินค้าที่จะแจก · Free product
      </span>

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

      {/* Radio list (single-select) */}
      <div
        role="radiogroup"
        aria-label="เลือกสินค้าที่จะแจก"
        className="max-h-[220px] overflow-y-auto rounded-[12px] border"
        style={{ borderColor: "var(--line)" }}
      >
        {state === "loading" ? (
          <div className="py-8 text-center text-[12.5px]" style={{ color: "var(--soft)" }}>
            กำลังโหลดสินค้า…
          </div>
        ) : state === "error" ? (
          <div className="py-8 text-center text-[12.5px]" style={{ color: "#dc2626" }}>
            โหลดสินค้าไม่สำเร็จ
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-8 text-center text-[12.5px]" style={{ color: "var(--soft)" }}>
            ไม่พบสินค้า · No matching products
          </div>
        ) : (
          filtered.map((p) => {
            const checked = value === p.id;
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={checked}
                onClick={() => onChange(p.id)}
                className="flex w-full items-center gap-3 border-b px-3 py-2.5 text-left transition last:border-b-0"
                style={{
                  borderColor: "var(--line)",
                  background: checked ? GOLD.bg : "transparent",
                }}
              >
                <span
                  aria-hidden="true"
                  className="grid h-4 w-4 flex-shrink-0 place-items-center rounded-full border"
                  style={{
                    borderColor: checked ? GOLD.fg : "var(--line)",
                    background: checked ? GOLD.fg : "#fff",
                    color: "#fff",
                  }}
                >
                  {checked && <Check size={11} strokeWidth={3} />}
                </span>
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
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
