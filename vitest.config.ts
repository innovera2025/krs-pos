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
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
