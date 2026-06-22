import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers/auth";

/**
 * Middleware route-gate regression (the gap that hid the auth-redirect bug).
 *
 * BUG: in this Auth.js v5 build the `auth((req) => … return NextResponse.next())`
 * wrapper's returned NextResponse WON over the `authorized` callback's
 * `return false`, so unauthenticated GET /pos (any protected shell route) returned
 * 200 instead of redirecting to /login. The fix enforces the gate explicitly
 * inside the middleware callback. This spec locks that behavior in.
 *
 * Style matches the rest of tests/e2e: no `webServer`, points at a running server
 * via E2E_BASE_URL, uses the `loginAs` helper. The orchestrator starts the server
 * + seeded Postgres and runs `npm run test:e2e`.
 */

const SELLER_EMAIL = "seller.aroon@krs-pos.local";
const SELLER_PASSWORD = "seller123";

test.describe("middleware route gate", () => {
  test("unauthenticated /pos redirects to /login", async ({ page }) => {
    // No prior sign-in: the gate must bounce to /login (the bug returned 200).
    await page.goto("/pos", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/login/);
  });

  test("unauthenticated /sales redirects to /login", async ({ page }) => {
    // A second protected prefix confirms the gate covers the nav scope, not just /pos.
    await page.goto("/sales", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/login/);
  });

  test("/login is reachable unauthenticated (no redirect loop)", async ({
    page,
  }) => {
    // /login is matcher-excluded + non-protected: it must load 200 and stay put.
    const response = await page.goto("/login", {
      waitUntil: "domcontentloaded",
    });
    expect(response, "no response for /login").not.toBeNull();
    expect(response!.status(), "/login status").toBeLessThan(400);
    await expect(page).toHaveURL(/\/login/);
    await expect(
      page.getByRole("heading", { name: "เข้าสู่ระบบ" })
    ).toBeVisible();
  });

  test("seller hitting an admin-only route is bounced to /pos", async ({
    page,
  }) => {
    // Signed-in SELLER (CASHIER → seller) may NOT reach /users (admin-only):
    // the gate redirects to /pos rather than /login.
    await loginAs(page, SELLER_EMAIL, SELLER_PASSWORD);

    await page.goto("/users", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/pos/);
  });
});
