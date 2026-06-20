"use client";

import type { DbStatus } from "./connectionTypes";

/**
 * Tri-state KRS live-status pill (state-live-status-fields-extra), ported from the
 * Simple POS source-of-truth into Taste. Driven by the client connection state:
 *  - testing      → amber "กำลังเชื่อมต่อ..."
 *  - connected    → green + pulsing dot "เรียลไทม์ · Live"
 *  - disconnected → amber "ออฟไลน์ · รอเชื่อมต่อ"
 *
 * NOTE (decision F): the connection state lives only on the /data screen, so this
 * pill is rendered on /data's tab bar only. /pos and /products are intentionally
 * NOT touched — cross-route sharing of the pill is deferred (would require lifting
 * the connection state to a provider).
 */
export function LiveStatusPill({
  status,
  testing,
  host,
}: {
  status: DbStatus;
  testing: boolean;
  /** Optional host suffix shown after the label (matches the source pill). */
  host?: string;
}) {
  const connected = status === "connected" && !testing;
  const label = testing
    ? "กำลังเชื่อมต่อ..."
    : connected
      ? "เรียลไทม์ · Live"
      : "ออฟไลน์ · รอเชื่อมต่อ";
  const color = connected ? "#15803d" : "#b45309";
  const bg = connected ? "#f0fdf4" : "#fffbeb";
  const border = connected ? "#bbf7d0" : "#fde68a";
  const dot = connected ? "#16a34a" : "#d97706";

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 rounded-[10px] px-[13px] py-[7px]"
      style={{ background: bg, border: `1px solid ${border}` }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: 99,
          background: dot,
          animation: connected ? "pulse 1.6s ease-in-out infinite" : "none",
        }}
      />
      <span className="mono text-[12px] font-bold" style={{ color }}>
        KRS · {label}
        {host ? ` · ${host}` : ""}
      </span>
    </div>
  );
}
