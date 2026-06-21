import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers/auth";

/**
 * 8-route smoke (Phase 7 regression guard). For each screen: navigate, assert the
 * HTTP response is not a 4xx/5xx, then assert a screen-specific marker is visible so
 * a blank/crashed render fails the test.
 *
 * AUTH (production-readiness Phase 1): the (shell) routes are now gated by
 * middleware, so each protected-route test signs in first via `loginAs` (seeded
 * admin → sees all 7 nav screens). The /login route itself is the one exception —
 * it is public and asserts the sign-in form, so it does NOT pre-authenticate.
 *
 * Authored, not run, in Phase 7: the orchestrator starts the server + Postgres and
 * runs `npm run test:e2e`. No webServer is configured here (see playwright.config).
 */

type RouteCheck = {
  path: string;
  /** A human label for the test title. */
  name: string;
  /** Assert a screen-specific marker is visible. */
  marker: (page: import("@playwright/test").Page) => Promise<void>;
  /** When true, sign in (seeded admin) before navigating. Default true. */
  auth?: boolean;
};

const ROUTES: RouteCheck[] = [
  {
    path: "/pos",
    name: "POS checkout",
    marker: async (page) => {
      await expect(
        page.getByRole("heading", { name: "ขายหน้าร้าน" })
      ).toBeVisible();
      // Empty-cart marker confirms the cart panel mounted.
      await expect(page.getByText("ตะกร้าว่าง")).toBeVisible();
    },
  },
  {
    path: "/sales",
    name: "Sales history",
    marker: async (page) => {
      await expect(
        page.getByRole("heading", { name: "ประวัติการขาย" })
      ).toBeVisible();
    },
  },
  {
    path: "/shift",
    name: "Shift close",
    marker: async (page) => {
      await expect(
        page.getByRole("heading", { name: "ปิดรอบขาย" })
      ).toBeVisible();
    },
  },
  {
    path: "/products",
    name: "Products (admin-gated)",
    marker: async (page) => {
      await expect(
        page.getByRole("heading", { name: "สินค้าและสต็อก" })
      ).toBeVisible();
    },
  },
  {
    path: "/users",
    name: "Users & roles (admin-gated)",
    marker: async (page) => {
      await expect(
        page.getByRole("heading", { name: "จัดการผู้ใช้และสิทธิ์" })
      ).toBeVisible();
    },
  },
  {
    path: "/data",
    name: "KRS Data Link (admin-gated)",
    marker: async (page) => {
      // The Connection tab is the default-selected tab in the ARIA tablist.
      await expect(
        page.getByRole("tab", { name: /เชื่อมต่อ/ })
      ).toBeVisible();
    },
  },
  {
    path: "/docs",
    name: "Design spec docs (admin-gated)",
    marker: async (page) => {
      // At least one pill tab is present in the docs tablist.
      await expect(page.getByRole("tab").first()).toBeVisible();
    },
  },
  {
    path: "/login",
    name: "Login",
    // Public route — do NOT pre-authenticate (we assert the sign-in form).
    auth: false,
    marker: async (page) => {
      await expect(
        page.getByRole("heading", { name: "เข้าสู่ระบบ" })
      ).toBeVisible();
      await expect(page.getByLabel(/อีเมล/)).toBeVisible();
    },
  },
];

for (const route of ROUTES) {
  test(`route smoke: ${route.name} (${route.path})`, async ({ page }) => {
    // Protected (shell) routes need a session — sign in first (seeded admin).
    if (route.auth !== false) {
      await loginAs(page);
    }

    const response = await page.goto(route.path, { waitUntil: "domcontentloaded" });
    expect(response, `no response for ${route.path}`).not.toBeNull();
    const status = response!.status();
    expect(
      status,
      `${route.path} returned HTTP ${status}`
    ).toBeLessThan(400);

    await route.marker(page);
  });
}
