"use client";

import { useEffect, useMemo, useState } from "react";
import type { Product, CartItem } from "@/types";

export default function POSPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [checkingOut, setCheckingOut] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/products", { signal: ctrl.signal })
      .then((r) => r.json())
      .then((data: Product[]) => setProducts(data))
      .catch((err) => {
        if (err?.name === "AbortError") return;
        setMessage("โหลดสินค้าไม่สำเร็จ — ตรวจสอบการเชื่อมต่อฐานข้อมูล");
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, []);

  const filtered = useMemo(
    () =>
      products.filter(
        (p) =>
          p.name.toLowerCase().includes(search.toLowerCase()) ||
          p.sku.toLowerCase().includes(search.toLowerCase())
      ),
    [products, search]
  );

  const subtotal = cart.reduce(
    (sum, item) => sum + Number(item.product.price) * item.quantity,
    0
  );

  function addToCart(product: Product) {
    setCart((prev) => {
      const existing = prev.find((i) => i.product.id === product.id);
      if (existing) {
        return prev.map((i) =>
          i.product.id === product.id ? { ...i, quantity: i.quantity + 1 } : i
        );
      }
      return [...prev, { product, quantity: 1 }];
    });
  }

  function updateQty(productId: string, delta: number) {
    setCart((prev) =>
      prev
        .map((i) =>
          i.product.id === productId
            ? { ...i, quantity: i.quantity + delta }
            : i
        )
        .filter((i) => i.quantity > 0)
    );
  }

  async function checkout() {
    if (cart.length === 0) return;
    setCheckingOut(true);
    setMessage(null);
    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: cart.map((i) => ({
            productId: i.product.id,
            quantity: i.quantity,
          })),
          paymentType: "CASH",
          amountPaid: subtotal,
        }),
      });
      if (!res.ok) throw new Error();
      const order = await res.json();
      setMessage(`ขายสำเร็จ! เลขที่บิล: ${order.orderNumber}`);
      setCart([]);
    } catch {
      setMessage("ชำระเงินไม่สำเร็จ ลองใหม่อีกครั้ง");
    } finally {
      setCheckingOut(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b bg-white px-6 py-4">
        <h1 className="text-xl font-bold">KRS POS</h1>
        <span className="text-sm text-slate-500">ระบบขายหน้าร้าน</span>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Product grid */}
        <section className="flex-1 overflow-y-auto p-6">
          <input
            type="text"
            placeholder="ค้นหาสินค้า (ชื่อ หรือ SKU)..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="mb-4 w-full rounded-lg border px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400"
          />

          {loading ? (
            <p className="text-slate-500">กำลังโหลด...</p>
          ) : filtered.length === 0 ? (
            <p className="text-slate-500">ไม่พบสินค้า</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {filtered.map((p) => (
                <button
                  key={p.id}
                  onClick={() => addToCart(p)}
                  className="flex flex-col items-start rounded-lg border bg-white p-4 text-left shadow-sm transition hover:border-blue-400 hover:shadow"
                >
                  <span className="font-medium">{p.name}</span>
                  <span className="text-xs text-slate-400">{p.sku}</span>
                  <span className="mt-2 text-lg font-bold text-blue-600">
                    ฿{Number(p.price).toFixed(2)}
                  </span>
                  <span className="text-xs text-slate-400">คงเหลือ {p.stock}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Cart */}
        <aside className="flex w-96 flex-col border-l bg-white">
          <div className="border-b px-6 py-4">
            <h2 className="font-semibold">ตะกร้าสินค้า</h2>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-4">
            {cart.length === 0 ? (
              <p className="text-sm text-slate-400">ยังไม่มีสินค้าในตะกร้า</p>
            ) : (
              <ul className="space-y-3">
                {cart.map((item) => (
                  <li
                    key={item.product.id}
                    className="flex items-center justify-between"
                  >
                    <div className="flex-1">
                      <p className="text-sm font-medium">{item.product.name}</p>
                      <p className="text-xs text-slate-400">
                        ฿{Number(item.product.price).toFixed(2)} × {item.quantity}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => updateQty(item.product.id, -1)}
                        className="h-7 w-7 rounded border text-slate-600 hover:bg-slate-100"
                      >
                        −
                      </button>
                      <span className="w-6 text-center text-sm">
                        {item.quantity}
                      </span>
                      <button
                        onClick={() => updateQty(item.product.id, 1)}
                        className="h-7 w-7 rounded border text-slate-600 hover:bg-slate-100"
                      >
                        +
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="border-t px-6 py-4">
            <div className="mb-3 flex items-center justify-between text-lg font-bold">
              <span>รวมทั้งสิ้น</span>
              <span>฿{subtotal.toFixed(2)}</span>
            </div>
            {message && (
              <p className="mb-3 text-sm text-blue-600">{message}</p>
            )}
            <button
              onClick={checkout}
              disabled={cart.length === 0 || checkingOut}
              className="w-full rounded-lg bg-blue-600 py-3 font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {checkingOut ? "กำลังชำระเงิน..." : "ชำระเงิน"}
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
