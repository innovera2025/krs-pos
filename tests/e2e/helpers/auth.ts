import { expect, type Page } from "@playwright/test";

/**
 * E2E sign-in helper (production-readiness Phase 1).
 *
 * Drives the real /login form (Auth.js Credentials) so protected-route tests pass
 * once middleware gates the (shell) routes. Navigates to /login, fills the
 * email/password, submits, and waits for the post-login redirect to land on /pos.
 *
 * Default credentials are the seeded dev admin (admin@krs-pos.local / admin123);
 * pass a CASHIER (e.g. seller.aroon@krs-pos.local / seller123) to exercise the
 * seller nav scope. Requires the DB to be seeded (orchestrator runs the seed).
 */
export async function loginAs(
  page: Page,
  email = "admin@krs-pos.local",
  password = "admin123"
): Promise<void> {
  await page.goto("/login", { waitUntil: "domcontentloaded" });

  // Fill the credentials (the email/password inputs use accessible labels).
  await page.getByLabel(/อีเมล/).fill(email);
  // Security-review FIX C: target the password INPUT by its EXACT label. A loose
  // /รหัสผ่าน/ match also hits the "แสดงรหัสผ่าน · Show password" toggle button
  // (strict-mode violation). Exact-match the input's label
  // ("รหัสผ่าน · Password") — the toggle's aria-label is the different string
  // "แสดงรหัสผ่าน · Show password", so exact-match resolves to the input only.
  await page
    .getByLabel("รหัสผ่าน · Password", { exact: true })
    .fill(password);

  // Submit via the sign-in button ("เข้าสู่ระบบ · Sign in").
  await page.getByRole("button", { name: /เข้าสู่ระบบ/ }).click();

  // After a successful sign-in the form redirects to /pos (the default target).
  await page.waitForURL("**/pos", { timeout: 15_000 });
  await expect(page).toHaveURL(/\/pos$/);
}
