"use client";

import {
  PRODUCT_MAP,
  PAYMENT_MAP,
  TAX_MAP,
  INVENTORY_MAP,
  type GlMapRow,
} from "./mappingData";

/**
 * Account-mapping section (LATENT — no prototype HTML; built from the Simple POS
 * data definitions + Taste). Four tables wiring POS concepts → KRS GL accounts:
 *   - productMap (4 rows; DS-001 ❌ ยังไม่ผูก)
 *   - paymentMap (5 rows; e-Wallet ❌)
 *   - taxMap (3 VAT → GL)
 *   - inventoryMap (4 Inventory/COGS/adjust/GRN → GL)
 * The two ❌ rows are what the FAILED seed jobs represent (warning, not a gate).
 */
export function AccountMappingSection() {
  return (
    <div className="flex flex-col gap-4">
      {/* Product → revenue account */}
      <Card title="ผูกสินค้า → บัญชีรายได้" subtitle="Product → revenue & VAT mapping">
        <div
          className="grid gap-[10px] border-b py-2 text-[11.5px] font-semibold"
          style={{ gridTemplateColumns: "0.9fr 1.6fr 1fr 1.4fr 0.7fr 110px", borderColor: "#eef2f6", color: "var(--soft)" }}
        >
          <div>SKU</div>
          <div>สินค้า</div>
          <div>หมวด</div>
          <div>บัญชีรายได้</div>
          <div>VAT</div>
          <div>สถานะ</div>
        </div>
        {PRODUCT_MAP.map((r) => (
          <div
            key={r.sku}
            className="grid items-center gap-[10px] border-b py-[11px]"
            style={{ gridTemplateColumns: "0.9fr 1.6fr 1fr 1.4fr 0.7fr 110px", borderColor: "#f4f7fa" }}
          >
            <div className="mono text-[12px] font-semibold" style={{ color: "#475569" }}>
              {r.sku}
            </div>
            <div className="text-[12.5px]" style={{ color: "#334155" }}>
              {r.name}
            </div>
            <div className="text-[12px]" style={{ color: "#64748b" }}>
              {r.cat}
            </div>
            <div
              className="text-[12px] font-medium"
              style={{ color: r.ok ? "#475569" : "#dc2626" }}
            >
              {r.acct}
            </div>
            <div className="text-[12px]" style={{ color: "#64748b" }}>
              {r.tax}
            </div>
            <div>
              <StatusBadge ok={r.ok} />
            </div>
          </div>
        ))}
      </Card>

      {/* Payment method → cash/clearing account */}
      <Card title="ผูกวิธีชำระ → บัญชีเงิน" subtitle="Payment method → cash/clearing account">
        <div
          className="grid gap-[10px] border-b py-2 text-[11.5px] font-semibold"
          style={{ gridTemplateColumns: "1fr 2fr 110px", borderColor: "#eef2f6", color: "var(--soft)" }}
        >
          <div>วิธีชำระ</div>
          <div>บัญชี</div>
          <div>สถานะ</div>
        </div>
        {PAYMENT_MAP.map((r) => (
          <div
            key={r.method}
            className="grid items-center gap-[10px] border-b py-[11px]"
            style={{ gridTemplateColumns: "1fr 2fr 110px", borderColor: "#f4f7fa" }}
          >
            <div className="text-[12.5px] font-medium" style={{ color: "#334155" }}>
              {r.method}
            </div>
            <div
              className="mono text-[12px]"
              style={{ color: r.ok ? "#475569" : "#dc2626" }}
            >
              {r.acct}
            </div>
            <div>
              <StatusBadge ok={r.ok} />
            </div>
          </div>
        ))}
      </Card>

      {/* Two GL maps side by side */}
      <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <Card title="ผูกภาษีขาย → GL" subtitle="VAT code → general ledger">
          {TAX_MAP.map((r) => (
            <GlRow key={r.left} row={r} />
          ))}
        </Card>
        <Card title="ผูกสต็อก → GL" subtitle="Inventory / COGS → general ledger">
          {INVENTORY_MAP.map((r) => (
            <GlRow key={r.left} row={r} />
          ))}
        </Card>
      </div>
    </div>
  );
}

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="rounded-2xl border px-5 py-[18px]"
      style={{ background: "#fff", borderColor: "#e8edf3" }}
    >
      <div className="mb-3">
        <div className="text-[14px] font-bold">{title}</div>
        <div className="text-[11.5px]" style={{ color: "var(--soft)" }}>
          {subtitle}
        </div>
      </div>
      {children}
    </div>
  );
}

function GlRow({ row }: { row: GlMapRow }) {
  return (
    <div
      className="flex items-center justify-between border-b py-[10px] last:border-b-0"
      style={{ borderColor: "#f4f7fa" }}
    >
      <span className="text-[12.5px] font-medium" style={{ color: "#334155" }}>
        {row.left}
      </span>
      <span className="mono text-[12px]" style={{ color: "#475569" }}>
        {row.right}
      </span>
    </div>
  );
}

function StatusBadge({ ok }: { ok: boolean }) {
  return (
    <span
      className="rounded-[7px] px-[9px] py-1 text-[11px] font-semibold"
      style={{
        background: ok ? "#f0fdf4" : "#fef2f2",
        color: ok ? "#15803d" : "#b91c1c",
      }}
    >
      {ok ? "ผูกแล้ว" : "ต้องผูก"}
    </span>
  );
}
