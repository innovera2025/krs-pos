"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Search,
  Plus,
  PackagePlus,
  AlertTriangle,
  Pencil,
} from "lucide-react";
import type { Category, Product } from "@/types";
import { useToast } from "@/components/ToastProvider";
import { AdminOnly } from "@/components/AdminOnly";
import { money } from "@/lib/money";
import {
  LOW_STOCK,
  monogramChar,
  monogramTint,
  stockStatus,
} from "@/components/products/productMeta";
import {
  ProductFormModal,
  type ProductFormValues,
} from "@/components/products/ProductFormModal";
import { ReceiveStockModal } from "@/components/products/ReceiveStockModal";

type LoadState = "loading" | "ready" | "error";

/** VAT rate (7% inclusive) — shown per-row as the extracted component. */
function inclusiveVat(price: number): number {
  return (price * 7) / 107;
}

export default function ProductsPage() {
  return (
    <AdminOnly>
      <ProductsScreen />
    </AdminOnly>
  );
}

function ProductsScreen() {
  const { showToast } = useToast();

  const [products, setProducts] = useState<Product[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [search, setSearch] = useState("");

  // Add/edit product modal.
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [formError, setFormError] = useState("");

  // Receive-stock modal.
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [receivePreselect, setReceivePreselect] = useState<string | null>(null);
  const [receiveSubmitting, setReceiveSubmitting] = useState(false);
  const [receiveError, setReceiveError] = useState("");

  async function loadProducts() {
    setLoadState("loading");
    try {
      const res = await fetch("/api/products");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Product[];
      setProducts(Array.isArray(data) ? data : []);
      setLoadState("ready");
    } catch {
      setLoadState("error");
    }
  }

  useEffect(() => {
    loadProducts();
  }, []);

  // Categories derived from fetched products (no dedicated endpoint in scope).
  const categories: Category[] = useMemo(() => {
    const byId = new Map<string, Category>();
    for (const p of products) {
      if (p.category && !byId.has(p.category.id)) {
        byId.set(p.category.id, { id: p.category.id, name: p.category.name });
      }
    }
    return Array.from(byId.values()).sort((a, b) =>
      a.name.localeCompare(b.name, "th")
    );
  }, [products]);

  // Search by name / sku / category name.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        (p.category?.name ?? "").toLowerCase().includes(q)
    );
  }, [products, search]);

  const lowStockCount = useMemo(
    () => products.filter((p) => stockStatus(p.stock) !== "ok").length,
    [products]
  );

  // ---- add / edit ----
  function openAdd() {
    setEditing(null);
    setFormError("");
    setFormOpen(true);
  }

  function openEdit(product: Product) {
    setEditing(product);
    setFormError("");
    setFormOpen(true);
  }

  async function submitForm(values: ProductFormValues) {
    setFormSubmitting(true);
    setFormError("");
    try {
      const isEdit = editing !== null;
      const url = isEdit ? `/api/products/${editing.id}` : "/api/products";
      const method = isEdit ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!res.ok) {
        let msg = "บันทึกสินค้าไม่สำเร็จ";
        try {
          const data = await res.json();
          if (data?.error) msg = data.error;
        } catch {
          /* keep default */
        }
        setFormError(msg);
        return;
      }
      setFormOpen(false);
      showToast(isEdit ? "บันทึกการแก้ไขแล้ว" : "เพิ่มสินค้าแล้ว");
      await loadProducts();
    } catch {
      setFormError("บันทึกสินค้าไม่สำเร็จ");
    } finally {
      setFormSubmitting(false);
    }
  }

  // ---- receive stock ----
  function openReceive(preselectId?: string) {
    setReceivePreselect(preselectId ?? null);
    setReceiveError("");
    setReceiveOpen(true);
  }

  async function submitReceive(input: {
    productId: string;
    qty: number;
    reference: string;
  }) {
    setReceiveSubmitting(true);
    setReceiveError("");
    try {
      const res = await fetch("/api/stock-movements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: input.productId,
          qty: input.qty,
          reference: input.reference.length > 0 ? input.reference : null,
        }),
      });
      if (!res.ok) {
        let msg = "รับสินค้าเข้าไม่สำเร็จ";
        try {
          const data = await res.json();
          if (data?.error) msg = data.error;
        } catch {
          /* keep default */
        }
        setReceiveError(msg);
        return;
      }
      setReceiveOpen(false);
      showToast(`รับสินค้าเข้า +${input.qty} แล้ว`);
      await loadProducts();
    } catch {
      setReceiveError("รับสินค้าเข้าไม่สำเร็จ");
    } finally {
      setReceiveSubmitting(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-[22px]">
      {/* Header */}
      <header className="flex flex-wrap items-center gap-3.5">
        <div className="flex-1 min-w-[220px]">
          <h1 className="m-0 text-[24px] font-bold leading-[1.08] tracking-tight">
            สินค้าและสต็อก
          </h1>
          <p className="mt-1 text-[12.5px]" style={{ color: "var(--muted)" }}>
            Products &amp; Inventory · จัดการรายการสินค้า รับเข้า และสต็อก
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => openReceive()}
            className="flex h-11 items-center gap-2 rounded-[14px] border px-4 text-[13.5px] font-semibold"
            style={{
              borderColor: "var(--line)",
              background: "#fff",
              color: "var(--ink)",
              boxShadow: "var(--shadow-sm)",
            }}
          >
            <PackagePlus size={17} strokeWidth={2} /> รับสินค้าเข้า
          </button>
          <button
            type="button"
            onClick={openAdd}
            className="flex h-11 items-center gap-2 rounded-[14px] px-4 text-[13.5px] font-bold text-white"
            style={{ background: "var(--brand)", boxShadow: "var(--shadow-sm)" }}
          >
            <Plus size={17} strokeWidth={2.5} /> เพิ่มสินค้า
          </button>
        </div>
      </header>

      {/* Search + low-stock badge */}
      <div className="flex flex-wrap items-center gap-3">
        <label
          className="flex h-12 flex-1 min-w-[240px] items-center gap-2.5 rounded-[14px] border bg-white px-3.5"
          style={{ borderColor: "var(--line)", boxShadow: "var(--shadow-sm)" }}
        >
          <Search size={18} strokeWidth={2} color="#667085" />
          <span className="sr-only">ค้นหาสินค้า ชื่อ หรือ SKU</span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="ค้นหาสินค้า ชื่อ / SKU / หมวดหมู่"
            autoComplete="off"
            aria-label="ค้นหาสินค้า ชื่อ หรือ SKU"
            className="min-w-0 flex-1 border-0 text-[14px] font-medium outline-none"
            style={{ color: "var(--ink)" }}
          />
        </label>

        {lowStockCount > 0 && (
          <span
            className="flex h-12 items-center gap-2 rounded-[14px] border px-4 text-[13px] font-semibold"
            style={{
              borderColor: "#fed7aa",
              background: "var(--accent-soft)",
              color: "#b45309",
            }}
          >
            <AlertTriangle size={16} strokeWidth={2} />
            สต็อกต่ำ/หมด {lowStockCount} รายการ
          </span>
        )}
      </div>

      {/* Table card */}
      <section
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[18px] border bg-white"
        style={{ borderColor: "var(--line)", boxShadow: "var(--shadow-sm)" }}
      >
        {loadState === "loading" ? (
          <div
            className="grid flex-1 place-items-center py-16 text-center text-[13px]"
            style={{ color: "var(--soft)" }}
          >
            กำลังโหลดสินค้า…
          </div>
        ) : loadState === "error" ? (
          <div
            className="mx-auto flex max-w-[320px] flex-1 flex-col items-center justify-center gap-3 py-16 text-center"
            style={{ color: "var(--muted)" }}
          >
            <span
              className="grid h-[64px] w-[64px] place-items-center rounded-[22px]"
              style={{ background: "var(--red-soft)", color: "#dc2626" }}
            >
              <AlertTriangle size={28} strokeWidth={2} />
            </span>
            <strong className="text-[14px]" style={{ color: "var(--ink)" }}>
              โหลดสินค้าไม่สำเร็จ
            </strong>
            <button
              type="button"
              onClick={loadProducts}
              className="h-10 rounded-[12px] border px-4 text-[13px] font-semibold"
              style={{ borderColor: "var(--line)" }}
            >
              ลองใหม่
            </button>
          </div>
        ) : products.length === 0 ? (
          <div
            className="grid flex-1 place-items-center py-16 text-center text-[13px]"
            style={{ color: "var(--soft)" }}
          >
            ยังไม่มีสินค้า · กด “เพิ่มสินค้า” เพื่อเริ่มต้น
          </div>
        ) : filtered.length === 0 ? (
          <div
            className="grid flex-1 place-items-center py-16 text-center text-[13px]"
            style={{ color: "var(--soft)" }}
          >
            ไม่พบสินค้า · No matching products
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr
                  className="sticky top-0 z-10 text-left"
                  style={{ background: "var(--surface-2)", color: "var(--muted)" }}
                >
                  <Th>SKU</Th>
                  <Th>สินค้า</Th>
                  <Th>หมวดหมู่</Th>
                  <Th className="text-right">ราคา</Th>
                  <Th className="text-right">VAT 7%</Th>
                  <Th>บาร์โค้ด</Th>
                  <Th>สถานะ</Th>
                  <Th className="text-right">จัดการ</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => {
                  const tint = monogramTint(p.category?.name);
                  const status = stockStatus(p.stock);
                  const priceNum = Number(p.price);
                  return (
                    <tr
                      key={p.id}
                      className="border-t"
                      style={{ borderColor: "var(--line)" }}
                    >
                      <Td>
                        <span className="mono text-[12px]" style={{ color: "var(--muted)" }}>
                          {p.sku}
                        </span>
                      </Td>
                      <Td>
                        <div className="flex items-center gap-2.5">
                          <span
                            aria-hidden="true"
                            className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-[12px] text-[15px] font-bold"
                            style={{ background: tint.bg, color: tint.fg }}
                          >
                            {monogramChar(p.name)}
                          </span>
                          <span className="font-semibold">{p.name}</span>
                        </div>
                      </Td>
                      <Td>
                        <span style={{ color: "var(--muted)" }}>
                          {p.category?.name ?? "—"}
                        </span>
                      </Td>
                      <Td className="text-right">
                        <span className="mono font-semibold">{money(priceNum)}</span>
                      </Td>
                      <Td className="text-right">
                        <span className="mono text-[12px]" style={{ color: "var(--muted)" }}>
                          {money(inclusiveVat(priceNum))}
                        </span>
                      </Td>
                      <Td>
                        <span className="mono text-[12px]" style={{ color: "var(--muted)" }}>
                          {p.barcode ?? "—"}
                        </span>
                      </Td>
                      <Td>
                        <StatusBadge status={status} />
                      </Td>
                      <Td className="text-right">
                        <div className="flex justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => openReceive(p.id)}
                            aria-label={`รับสินค้าเข้า ${p.name}`}
                            title="รับสินค้าเข้า"
                            className="grid h-9 w-9 place-items-center rounded-[11px] border"
                            style={{ borderColor: "var(--line)", color: "var(--brand-2)" }}
                          >
                            <PackagePlus size={16} strokeWidth={2} />
                          </button>
                          <button
                            type="button"
                            onClick={() => openEdit(p)}
                            aria-label={`แก้ไข ${p.name}`}
                            title="แก้ไข"
                            className="grid h-9 w-9 place-items-center rounded-[11px] border"
                            style={{ borderColor: "var(--line)", color: "var(--ink)" }}
                          >
                            <Pencil size={15} strokeWidth={2} />
                          </button>
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ProductFormModal
        open={formOpen}
        editing={editing}
        categories={categories}
        submitting={formSubmitting}
        error={formError}
        onClose={() => setFormOpen(false)}
        onSubmit={submitForm}
      />

      <ReceiveStockModal
        open={receiveOpen}
        products={products}
        preselectId={receivePreselect}
        submitting={receiveSubmitting}
        error={receiveError}
        onClose={() => setReceiveOpen(false)}
        onSubmit={submitReceive}
      />
    </div>
  );
}

function Th({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th className={`px-4 py-2.5 text-[11.5px] font-semibold uppercase tracking-wide ${className}`}>
      {children}
    </th>
  );
}

function Td({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-4 py-3 align-middle ${className}`}>{children}</td>;
}

function StatusBadge({ status }: { status: "out" | "low" | "ok" }) {
  const map = {
    ok: { label: "ขายอยู่", bg: "var(--mint)", fg: "var(--brand-2)" },
    low: { label: `สต็อกต่ำ (≤${LOW_STOCK})`, bg: "var(--accent-soft)", fg: "#b45309" },
    out: { label: "หมด", bg: "var(--red-soft)", fg: "#b42318" },
  } as const;
  const m = map[status];
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-1 text-[11.5px] font-semibold"
      style={{ background: m.bg, color: m.fg }}
    >
      {m.label}
    </span>
  );
}
