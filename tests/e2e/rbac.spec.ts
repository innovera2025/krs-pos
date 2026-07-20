import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers/auth";

/**
 * Seller-scope RBAC (auth Phase 2). Signs in as the seeded CASHIER
 * (seller.aroon@krs-pos.local / seller123) and asserts the server-side guards:
 *
 *  CAN (POS flow stays intact):
 *    - navigate /pos, /sales, /shift (the seller's nav scope)
 *    - GET /api/products → 200, GET /api/customers → 200, GET /api/shift → 200
 *      (carried over the session cookie via page.request)
 *
 *  CANNOT (admin-only surfaces rejected):
 *    - POST /api/products            → 403 (create product is admin)
 *    - GET  /api/sync-jobs           → 403 (KRS Data Link is admin)
 *    - PATCH /api/orders/<id> void   → 403 (a cashier may not void a sale)
 *
 * page.request shares the BrowserContext cookies, so these API calls carry the
 * authenticated seller session. Authored, not run, here — the orchestrator starts
 * the server + Postgres and runs the suite. Requires the seed (the CASHIER user).
 */

const SELLER_EMAIL = "seller.aroon@krs-pos.local";
const SELLER_PASSWORD = "seller123";

test.describe("RBAC: seller (CASHIER) scope", () => {
  test("seller CAN reach POS routes + POS read APIs", async ({ page }) => {
    await loginAs(page, SELLER_EMAIL, SELLER_PASSWORD);

    // The seller nav rail shows only pos / sales / shift — each navigates and
    // renders its screen heading (a blank/redirected render would fail).
    await page.goto("/pos", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "ขายหน้าร้าน" })
    ).toBeVisible();

    await page.goto("/sales", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "ประวัติการขาย" })
    ).toBeVisible();

    await page.goto("/shift", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "ปิดรอบขาย" })
    ).toBeVisible();

    // POS read APIs the cashier needs are allowed (requireUser, not admin).
    const products = await page.request.get("/api/products");
    expect(products.status(), "GET /api/products").toBe(200);

    const customers = await page.request.get("/api/customers");
    expect(customers.status(), "GET /api/customers").toBe(200);

    const shift = await page.request.get("/api/shift");
    expect(shift.status(), "GET /api/shift").toBe(200);
  });

  test("seller CANNOT reach admin-only APIs", async ({ page }) => {
    await loginAs(page, SELLER_EMAIL, SELLER_PASSWORD);

    // Create-product is admin-only → 403.
    const createProduct = await page.request.post("/api/products", {
      data: { name: "RBAC test", sku: "RBAC-TEST", price: 10 },
    });
    expect(createProduct.status(), "POST /api/products").toBe(403);

    // KRS sync-jobs list is admin-only → 403.
    const syncJobs = await page.request.get("/api/sync-jobs");
    expect(syncJobs.status(), "GET /api/sync-jobs").toBe(403);

    // Voiding a sale is admin-only. Find a real order id (the seller may GET the
    // sales ledger), else fall back to a synthetic id — either way the admin gate
    // fires before any DB lookup, so the cashier gets a 403.
    const ordersRes = await page.request.get("/api/orders");
    expect(ordersRes.status(), "GET /api/orders (seller)").toBe(200);
    // GET /api/orders now returns { orders, summary } (Sales History range filter),
    // not a bare array — read the `orders` field for a real id to void.
    const body = (await ordersRes.json()) as { orders?: Array<{ id: string }> };
    const orders = body.orders ?? [];
    const orderId =
      Array.isArray(orders) && orders.length > 0
        ? orders[0].id
        : "nonexistent-order-id";

    const voidRes = await page.request.patch(`/api/orders/${orderId}`, {
      data: { action: "void" },
    });
    expect(voidRes.status(), "PATCH /api/orders void (seller)").toBe(403);
  });
});
