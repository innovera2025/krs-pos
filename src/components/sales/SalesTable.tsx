"use client";

import type { OrderDTO } from "@/types";
import { money } from "@/lib/money";
import {
  statusMeta,
  syncMeta,
  formatSaleTime,
  WALK_IN_LABEL,
} from "./saleMeta";

type SalesTableProps = {
  orders: OrderDTO[];
  onOpenSale: (order: OrderDTO) => void;
};

/**
 * Sales History table (screen-sales-history). Ported from the Simple POS
 * 7-column grid into Taste: posNo (mono) · time · customer·acctDoc · amount
 * (right, handles negative) · status badge · sync badge · ใบกำกับ flag.
 * Rows are clickable → openSaleDetail (action-open-sale-detail).
 */
export function SalesTable({ orders, onOpenSale }: SalesTableProps) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr
            className="sticky top-0 z-10 text-left"
            style={{ background: "var(--surface-2)", color: "var(--muted)" }}
          >
            <Th>เลขบิล POS</Th>
            <Th>เวลา</Th>
            <Th>ลูกค้า · เอกสารบัญชี</Th>
            <Th className="text-right">ยอด</Th>
            <Th>สถานะ</Th>
            <Th>ซิงค์บัญชี</Th>
            <Th className="text-right">ใบกำกับ</Th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => {
            const st = statusMeta(o.status);
            const sy = syncMeta(o.syncStatus);
            const acctNo = o.accountingDocNo ?? "—";
            return (
              <tr
                key={o.id}
                onClick={() => onOpenSale(o)}
                role="button"
                tabIndex={0}
                aria-label={`เปิดรายละเอียดบิล ${o.orderNumber}`}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpenSale(o);
                  }
                }}
                className="cursor-pointer border-t transition hover:bg-[var(--surface-2)]"
                style={{ borderColor: "var(--line)" }}
              >
                <Td>
                  <span className="mono text-[12.5px] font-semibold" style={{ color: "var(--ink)" }}>
                    {o.orderNumber}
                  </span>
                </Td>
                <Td>
                  <span className="mono text-[12px]" style={{ color: "var(--soft)" }}>
                    {formatSaleTime(o.createdAt)}
                  </span>
                </Td>
                <Td>
                  <div className="min-w-0">
                    <div
                      className="overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-medium"
                      style={{ color: "#334155" }}
                    >
                      {o.customer?.name ?? WALK_IN_LABEL}
                    </div>
                    <div className="mono text-[11px]" style={{ color: "var(--soft)" }}>
                      {acctNo}
                    </div>
                  </div>
                </Td>
                <Td className="text-right">
                  <span className="mono text-[13.5px] font-semibold" style={{ color: "var(--ink)" }}>
                    {money(Number(o.total))}
                  </span>
                </Td>
                <Td>
                  <Badge meta={st} />
                </Td>
                <Td>
                  <Badge meta={sy} />
                </Td>
                <Td className="text-right">
                  {o.taxRequested ? (
                    <span
                      className="inline-flex items-center rounded-md border px-2 py-1 text-[10.5px] font-semibold"
                      style={{ background: "#eff6ff", color: "#2563eb", borderColor: "#bfdbfe" }}
                    >
                      ใบกำกับ
                    </span>
                  ) : null}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Badge({ meta }: { meta: { label: string; bg: string; fg: string; dot: string } }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] font-semibold"
      style={{ background: meta.bg, color: meta.fg }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.dot }} />
      {meta.label}
    </span>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-4 py-2.5 text-[11.5px] font-semibold uppercase tracking-wide ${className}`}
    >
      {children}
    </th>
  );
}

function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-middle ${className}`}>{children}</td>;
}
