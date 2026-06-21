import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers/auth";

/**
 * POS checkout happy-path (Phase 7 regression guard). Exercises the core sale flow
 * end to end against a running, seeded instance:
 *   /pos → add a product to the cart → open payment → pay cash (exact) → receipt
 *   success → "New sale" resets back to an empty cart.
 *
 * AUTH (production-readiness Phase 1): /pos is gated by middleware and POST
 * /api/orders requires a session (the cashier is taken from it), so the test
 * signs in first via `loginAs` (seeded admin).
 *
 * Selectors are accessible roles / visible text (no brittle CSS). Authored, not run,
 * in Phase 7 — the orchestrator starts the server + Postgres and runs the suite.
 */

test("checkout: add product, pay cash, see receipt, reset", async ({ page }) => {
  await loginAs(page);
  await page.goto("/pos", { waitUntil: "domcontentloaded" });

  // The cart starts empty.
  await expect(page.getByText("ตะกร้าว่าง")).toBeVisible();

  // Add the first product to the cart. Product cards expose an aria-label of the
  // form "เพิ่ม <name> (<sku>) ลงตะกร้า · <price>", which only product cards use.
  const firstProduct = page
    .getByRole("button", { name: /^เพิ่ม .* ลงตะกร้า/ })
    .first();
  await expect(firstProduct).toBeVisible();
  await firstProduct.click();

  // The empty-cart placeholder is gone once a line is added.
  await expect(page.getByText("ตะกร้าว่าง")).toHaveCount(0);

  // Open the payment modal via the pay button in the totals bar.
  await page.getByRole("button", { name: /ชำระเงิน/ }).first().click();

  // The payment modal is open (its heading is "วิธีชำระเงิน · Payment").
  await expect(
    page.getByRole("heading", { name: /วิธีชำระเงิน/ })
  ).toBeVisible();

  // Cash is the seeded default method, so the cash panel is shown. Click the
  // "พอดี" (exact) quick-cash preset so cash received == cash due.
  await page.getByRole("button", { name: "พอดี" }).click();

  // Confirm the payment.
  await page.getByRole("button", { name: /ยืนยันการชำระเงิน/ }).click();

  // The receipt success state appears.
  await expect(
    page.getByRole("heading", { name: "ชำระเงินสำเร็จ" })
  ).toBeVisible();

  // "เริ่มบิลใหม่ · New sale" is the only dismissal — it resets to an empty cart.
  await page.getByRole("button", { name: /เริ่มบิลใหม่/ }).click();
  await expect(
    page.getByRole("heading", { name: "ชำระเงินสำเร็จ" })
  ).toHaveCount(0);
  await expect(page.getByText("ตะกร้าว่าง")).toBeVisible();
});
