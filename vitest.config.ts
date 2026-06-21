import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Vitest config for KRS POS unit tests (Financial/Inventory correctness).
 *
 * Scope: PURE unit tests only — no DB, no server, no Next runtime. The suite
 * targets the integer-satang money/recompute logic in `src/lib/pricing.ts`
 * (computeTotals, computeOrderTotals). Run with `npm test` (vitest run).
 *
 * `environment: "node"` because the money math is platform-agnostic and needs no
 * DOM. The `@/*` alias mirrors tsconfig so test imports match production code.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      // Scope coverage to library logic — the money/inventory correctness code
      // lives under src/lib. Route handlers / UI are exercised by Playwright e2e,
      // not by these pure unit tests, so including them would report misleading 0%.
      include: ["src/lib/**"],
      // Per-file ratchet on the money module: a drop in pricing.ts coverage fails
      // CI so pricing regressions can't ship untested. Start just below today's
      // measured number and raise it over time.
      thresholds: {
        "src/lib/pricing.ts": { lines: 85, functions: 85 },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
