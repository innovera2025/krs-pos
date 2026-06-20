import { IMPL_ROWS } from "./docsContent";

/**
 * Implementation notes panel — Simple POS source lines 805–815 (data: IMPL_ROWS,
 * 6 cards). "Implementation notes (frontend)" — title + body each.
 * Ported into Taste. NOTE (Phase 6c decision B): several notes describe roadmap /
 * production-readiness architecture (IndexedDB sync queue, exponential backoff,
 * idempotency keys, state-machine statuses) that the MVP build does not yet ship.
 * Kept AS DOCUMENTED — this is the design spec, not a description of current code.
 */

export function ImplPanel() {
  return (
    <div className="flex flex-col gap-3.5">
      <div className="text-[18px] font-bold">Implementation notes (frontend)</div>
      {IMPL_ROWS.map((r) => (
        <div
          key={r.title}
          className="rounded-[13px] px-5 py-4"
          style={{ background: "var(--surface)", border: "1px solid var(--line)" }}
        >
          <div className="mb-1.5 text-[13.5px] font-bold" style={{ color: "var(--ink)" }}>
            {r.title}
          </div>
          <div className="text-[12.5px] leading-[1.7]" style={{ color: "var(--muted)" }}>
            {r.body}
          </div>
        </div>
      ))}
    </div>
  );
}
