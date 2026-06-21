import type { ShopSettingsDTO } from "@/types";

/**
 * Dynamic thermal-receipt print sizing (Receipt print-size feature) — CLIENT-SAFE
 * (pure DOM; no Prisma / NODE-only imports). Both the POS receipt and the Sales
 * History reprint call this so the printed `.print-receipt` paper uses the
 * admin-configured size instead of the hardcoded `globals.css` 80mm default.
 *
 * Why inject a <style> (decision D3): CSS variables do NOT resolve inside `@page`
 * rules in any browser, so the page `size` cannot be driven by a CSS custom
 * property. The robust mechanism is to inject a `<style>` carrying the COMPUTED
 * `@page { size: <W>mm <H> }` (+ `.print-receipt { width }`) into <head> right
 * before `window.print()`, then remove it after printing.
 *
 * Isolation: this ONLY targets the 80mm thermal `.print-receipt` path. It never
 * touches the A4 tax-invoice named page (`@page tax-invoice` /
 * `body.printing-tax-invoice` / `.print-tax-invoice`), and the `globals.css`
 * `@page { size: 80mm auto }` rule stays as the fallback default — the injected
 * rule simply overrides it (later, more specific source order) while present.
 */

/** The id on the injected <style> so it can be found + removed (and never
 *  duplicated across rapid re-prints). */
const STYLE_ID = "receipt-page-size-dynamic";

/** Inner page margin (mm) — matches the globals.css thermal default. */
const PAGE_MARGIN_MM = 4;

/** Paper content inset (mm) subtracted from width so the `.print-receipt` body
 *  sits inside the page margins (mirrors the globals.css 80→72mm relationship). */
const CONTENT_INSET_MM = 8;

/** Bounds (mm) mirroring the API Zod schema, applied defensively in case the
 *  client holds a stale/out-of-range value (the injected rule never exceeds the
 *  printable range). */
const WIDTH_MIN = 40;
const WIDTH_MAX = 120;
const HEIGHT_MIN = 50;
const HEIGHT_MAX = 400;

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Build the `@media print` CSS that overrides the page box + receipt width from
 * the configured settings. Height is `auto` when `receiptHeightAuto`, else the
 * fixed mm value. The content width is `width - CONTENT_INSET_MM` (≥ 1mm).
 */
function buildPageCss(settings: ShopSettingsDTO): string {
  const widthMm = clamp(settings.receiptWidthMm, WIDTH_MIN, WIDTH_MAX);
  const height = settings.receiptHeightAuto
    ? "auto"
    : `${clamp(settings.receiptHeightMm ?? HEIGHT_MIN, HEIGHT_MIN, HEIGHT_MAX)}mm`;
  const contentMm = Math.max(1, widthMm - CONTENT_INSET_MM);

  return `@media print {
  @page { size: ${widthMm}mm ${height}; margin: ${PAGE_MARGIN_MM}mm }
  .print-receipt { width: ${contentMm}mm }
}`;
}

/** Remove the injected sizing <style> if present (safe to call repeatedly). */
function removeDynamicStyle(): void {
  if (typeof document === "undefined") return;
  const existing = document.getElementById(STYLE_ID);
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
}

/**
 * Last-chance fetch of the configured receipt size when the caller passed null
 * (cold/slow page load: the print fired before `GET /api/settings` resolved).
 *
 * Returns the fetched settings, or null on ANY failure (non-OK, bad shape,
 * network error) so the caller falls back to the globals.css 80mm default —
 * printing must never be blocked on a settings load. CLIENT-SAFE: uses the same
 * `{ settings }` envelope the page fetches; no Prisma / NODE-only imports.
 */
async function fetchSettings(): Promise<ShopSettingsDTO | null> {
  try {
    const res = await fetch("/api/settings");
    if (!res.ok) return null;
    const data = (await res.json()) as { settings: ShopSettingsDTO } | null;
    return data?.settings ?? null;
  } catch {
    return null;
  }
}

/** Inject the computed `@page` style, print, and clean up. Assumes a DOM. */
function injectAndPrint(settings: ShopSettingsDTO): void {
  // Replace any prior injected style (guards against a leftover from a previous
  // print that didn't clean up, and against double-inject on rapid re-prints).
  removeDynamicStyle();

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = buildPageCss(settings);
  document.head.appendChild(style);

  // Clean up after the print dialog closes. `afterprint` is the primary signal;
  // a timeout fallback guarantees removal even if the event never fires.
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    window.removeEventListener("afterprint", cleanup);
    removeDynamicStyle();
  };
  window.addEventListener("afterprint", cleanup);
  // Fallback: remove the style shortly after even if afterprint is suppressed.
  window.setTimeout(cleanup, 2000);

  try {
    window.print();
  } catch {
    // Printing unavailable → still clean up the injected style immediately.
    cleanup();
  }
}

/** Bare print at the globals.css 80mm default (no injected size override). */
function printDefault(): void {
  try {
    window.print();
  } catch {
    /* printing unavailable in this environment */
  }
}

/**
 * Print the currently-open `.print-receipt` using the configured receipt size.
 *
 * Injects the computed `@page` rule into <head>, calls `window.print()`, and
 * cleans up via an `afterprint` listener with a timeout fallback (some browsers
 * fire `afterprint` unreliably).
 *
 * When `settings` is null (cold/slow load: the print fired before the page's
 * `GET /api/settings` resolved) this AWAITS a last-chance fetch and prints with
 * the fetched size — eliminating the race where a non-80mm admin setting would
 * otherwise print at 80mm. Only if that fetch ALSO fails does it fall back to a
 * bare `window.print()` (globals.css 80mm). Printing is never blocked on error.
 *
 * Returns a Promise; call sites fire-and-forget (they ignore the result).
 */
export async function printReceiptWithSize(
  settings: ShopSettingsDTO | null
): Promise<void> {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  // No settings passed → try a last-chance fetch before printing. If the fetch
  // resolves, print at the configured size; if it fails, fall back to 80mm.
  if (!settings) {
    const fetched = await fetchSettings();
    if (!fetched) {
      printDefault();
      return;
    }
    injectAndPrint(fetched);
    return;
  }

  injectAndPrint(settings);
}
