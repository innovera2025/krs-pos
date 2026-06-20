"use client";

import { useState } from "react";
import { AdminOnly } from "@/components/AdminOnly";
import { DOC_TABS, type DocTabKey } from "@/components/docs/docsContent";
import { OverviewPanel } from "@/components/docs/OverviewPanel";
import { IaPanel } from "@/components/docs/IaPanel";
import { FlowsPanel } from "@/components/docs/FlowsPanel";
import { ScreensPanel } from "@/components/docs/ScreensPanel";
import { ComponentsPanel } from "@/components/docs/ComponentsPanel";
import { TokensPanel } from "@/components/docs/TokensPanel";
import { CopyPanel } from "@/components/docs/CopyPanel";
import { RulesPanel } from "@/components/docs/RulesPanel";
import { VisualPanel } from "@/components/docs/VisualPanel";
import { ImplPanel } from "@/components/docs/ImplPanel";

/**
 * Admin Design Spec docs hub (Phase 6c — closes Phase 6). A pill tab switcher
 * over 10 STATIC content panels reproduced faithfully from the Simple POS
 * source-of-truth (design/Simple POS.dc.html, template 560–820 / data 1794–1882),
 * ported into the Taste visual language. AdminOnly-wrapped (the client demo guard;
 * seller → redirect /pos), like /products /users /data.
 *
 * STATIC ONLY — no API/DB/schema/seed. All content lives in
 * src/components/docs/docsContent.ts + the per-panel components. This is a *design
 * document*: some entries (impl notes, a few component names) are roadmap/spec and
 * are kept as documented rather than rewritten to match the current build.
 */

const PANELS: Record<DocTabKey, () => JSX.Element> = {
  overview: OverviewPanel,
  ia: IaPanel,
  flows: FlowsPanel,
  screens: ScreensPanel,
  components: ComponentsPanel,
  tokens: TokensPanel,
  copy: CopyPanel,
  rules: RulesPanel,
  visual: VisualPanel,
  impl: ImplPanel,
};

export default function DocsPage() {
  return (
    <AdminOnly>
      <DocsScreen />
    </AdminOnly>
  );
}

function DocsScreen() {
  const [docsTab, setDocsTab] = useState<DocTabKey>("overview");
  const ActivePanel = PANELS[docsTab];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Pill tab switcher */}
      <div
        className="flex gap-[7px] overflow-x-auto px-[22px] py-3.5"
        style={{ background: "var(--surface)", borderBottom: "1px solid var(--line)" }}
      >
        {DOC_TABS.map((t) => {
          const active = docsTab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              aria-current={active ? "page" : undefined}
              title={t.en}
              onClick={() => setDocsTab(t.key)}
              className="cursor-pointer whitespace-nowrap rounded-full px-[15px] py-[9px] text-[13px] font-semibold transition"
              style={
                active
                  ? { background: "var(--forest)", color: "#fff" }
                  : { background: "var(--surface)", color: "var(--muted)", border: "1px solid var(--line-strong)" }
              }
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Active panel body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-[22px] py-6" style={{ background: "var(--bg)" }}>
        <div className="mx-auto" style={{ maxWidth: 980 }}>
          {/* Subtle one-line note: this is a design-spec package (some items are roadmap). */}
          <div className="mb-4 text-[11.5px]" style={{ color: "var(--soft)" }}>
            เอกสารออกแบบระบบ · Product Design Package — บางรายการเป็นสเปก/แผนต่อยอด (roadmap) ไม่ใช่สถานะโค้ดปัจจุบัน
          </div>
          <ActivePanel />
        </div>
      </div>
    </div>
  );
}
