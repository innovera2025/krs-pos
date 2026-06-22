import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { loginAs } from "./helpers/auth";

/**
 * Auth Phase 3 e2e — account lockout, force-logout (tokenVersion), and
 * set-password (admin-create + admin reset).
 *
 * Isolation rule (research §regression risks): every test user is created via the
 * admin API with a UNIQUE email per run, so the suite NEVER touches the seeded
 * admin (admin@krs-pos.local) — a lockout/force-logout on the seeded admin would
 * break the other specs. Created users are deactivated in cleanup (no destructive
 * delete in this domain).
 *
 * Thresholds under test (src/auth.ts): persistent lockout at 10 consecutive
 * failures for 15 min; the in-memory per-IP:email limiter is 15 (so 11 failed
 * logins trip lockout, NOT the rate limiter). Authored, not run, here — the
 * orchestrator starts the server + Postgres + seed and runs the suite.
 */

const LOCKED_MSG = /บัญชีถูกล็อก/; // "Account temporarily locked"
const INVALID_MSG = /อีเมลหรือรหัสผ่านไม่ถูกต้อง/; // generic "Invalid email or password"

/** A unique, non-colliding test email for this run. */
function uniqueEmail(tag: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `e2e-p3-${tag}-${Date.now().toString(36)}-${rand}@krs-pos.local`;
}

/**
 * Create an isolated CASHIER via the admin API (set-password Option 1: the admin
 * sets the initial password). Returns the created user's id + credentials.
 */
async function createTestUser(
  admin: APIRequestContext,
  tag: string,
  password: string
): Promise<{ id: string; email: string; password: string }> {
  const email = uniqueEmail(tag);
  const res = await admin.post("/api/users", {
    data: { name: `E2E ${tag}`, email, role: "CASHIER", password },
  });
  expect(res.status(), `POST /api/users (${tag})`).toBe(201);
  const user = (await res.json()) as { id: string };
  return { id: user.id, email, password };
}

/** Best-effort cleanup: deactivate the test user (no destructive delete). */
async function deactivateUser(admin: APIRequestContext, id: string): Promise<void> {
  await admin
    .patch(`/api/users/${id}`, { data: { isActive: false } })
    .catch(() => undefined);
}

/**
 * Fill + submit the /login form (no redirect assertion — caller decides).
 *
 * Determinism: we WAIT for the Auth.js credentials-callback response before
 * returning. Without this, the caller's next `page.goto("/login")` can abort the
 * still-in-flight sign-in request, so the server-side failed-attempt increment
 * never lands — which silently under-counts the lockout loop and makes it flaky
 * (the form's error alert can render from client state before the round-trip
 * completes, so waiting on the alert alone is not a reliable "request done"
 * signal). Waiting on the actual POST response guarantees authorize() ran (and,
 * since the lockout counter update is awaited, that it committed).
 */
async function attemptLogin(
  page: Page,
  email: string,
  password: string
): Promise<void> {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await page.getByLabel(/อีเมล/).fill(email);
  await page.getByLabel("รหัสผ่าน · Password", { exact: true }).fill(password);
  const callbackDone = page.waitForResponse(
    (r) =>
      r.url().includes("/api/auth/callback/credentials") &&
      r.request().method() === "POST",
    { timeout: 15_000 }
  );
  await page.getByRole("button", { name: /เข้าสู่ระบบ/ }).click();
  await callbackDone;
}

test.describe("Auth Phase 3: lockout / force-logout / set-password", () => {
  test("lockout after 10 failures → ACCOUNT_LOCKED, admin unlock restores login", async ({
    page,
    browser,
  }) => {
    // Admin API context (seeded admin) — used only to create + manage the
    // isolated test user.
    const adminPage = await browser.newPage();
    await loginAs(adminPage);
    const admin = adminPage.request;

    const good = "Lockout-pass-1";
    const user = await createTestUser(admin, "lockout", good);

    try {
      // 10 consecutive WRONG-password attempts → the 10th trips the lock. Each of
      // the first attempts shows the generic invalid-credentials message (and
      // attemptLogin has already awaited the server round-trip, so the failed-
      // attempt increment has committed before the next iteration navigates).
      for (let i = 0; i < 10; i++) {
        await attemptLogin(page, user.email, "wrong-password");
        await expect(page.getByText(INVALID_MSG)).toBeVisible();
      }

      // The 11th attempt (even with the CORRECT password) is rejected by the
      // lockout branch with the distinct ACCOUNT_LOCKED message.
      await attemptLogin(page, user.email, good);
      await expect(page.getByText(LOCKED_MSG)).toBeVisible();
      // Still on /login (no session was issued).
      await expect(page).toHaveURL(/\/login/);

      // Admin unlocks the account → the correct password works again.
      const unlockRes = await admin.patch(`/api/users/${user.id}`, {
        data: { action: "unlock" },
      });
      expect(unlockRes.status(), "PATCH unlock").toBe(200);

      await attemptLogin(page, user.email, good);
      await page.waitForURL("**/pos", { timeout: 15_000 });
      await expect(page).toHaveURL(/\/pos$/);
    } finally {
      await deactivateUser(admin, user.id);
      await adminPage.close();
    }
  });

  test("force-logout: admin tokenVersion bump invalidates the user's session", async ({
    browser,
  }) => {
    // This test intentionally waits out the throttled jwt liveness re-check
    // window (~10s, SESSION_REVALIDATE_MS) before revocation lands, so raise the
    // per-test timeout well above the global 30s default — otherwise the poll
    // below (and the configured single retry) could time out.
    test.setTimeout(45_000);

    // Admin context (seeded admin) creates the user + performs the force-logout.
    const adminPage = await browser.newPage();
    await loginAs(adminPage);
    const admin = adminPage.request;

    const good = "ForceLogout-pass-1";
    const user = await createTestUser(admin, "forcelogout", good);

    // The target user signs in in their OWN browser context (separate cookies).
    const userContext = await browser.newContext();
    const userPage = await userContext.newPage();

    try {
      await loginAs(userPage, user.email, good);

      // The user can reach a protected route while their session is valid.
      await userPage.goto("/sales", { waitUntil: "domcontentloaded" });
      await expect(
        userPage.getByRole("heading", { name: "ประวัติการขาย" })
      ).toBeVisible();

      // Sanity: BEFORE force-logout the user's session can read a protected API.
      const beforeFL = await userPage.request.get("/api/orders");
      expect(beforeFL.status(), "pre-force-logout API access").toBe(200);

      // Admin force-logout → bumps tokenVersion; every existing JWT for the user
      // is now stale.
      const flRes = await admin.patch(`/api/users/${user.id}`, {
        data: { action: "forceLogout" },
      });
      expect(flRes.status(), "PATCH forceLogout").toBe(200);

      // Force-logout is enforced at the DATA boundary, but the Node `auth()` jwt
      // liveness re-check is THROTTLED to once per ~10s (SESSION_REVALIDATE_MS)
      // as a perf optimization, so revocation is bounded-eventual, not instant:
      // the user's stamped tokenVersion is only re-read from the DB on the first
      // request at/after ~10s from sign-in, at which point the stale JWT is
      // rejected → 401 on any authenticated API. (The edge middleware is a UX
      // gate only — it does NOT re-read the DB — so the static page SHELL may
      // still render until the cookie expires; the real revocation is that every
      // data call/mutation fails once the throttled re-check lands. Page-level
      // redirect-on-revoke is a documented, deferred enhancement.)
      //
      // Poll until the revocation lands (well within the window + margin).
      await expect
        .poll(
          async () => (await userPage.request.get("/api/orders")).status(),
          {
            message: "force-logout revokes API access within the revalidation window",
            timeout: 15_000,
          }
        )
        .toBe(401);
    } finally {
      await deactivateUser(admin, user.id);
      await userContext.close();
      await adminPage.close();
    }
  });

  test("set-password: admin-create lets the user log in; admin reset rotates it", async ({
    browser,
  }) => {
    const adminPage = await browser.newPage();
    await loginAs(adminPage);
    const admin = adminPage.request;

    const original = "SetPassword-orig-1";
    const user = await createTestUser(admin, "setpw", original);

    // The user logs in with the admin-set password (the can't-login bug is fixed).
    const userContext = await browser.newContext();
    const userPage = await userContext.newPage();

    try {
      await loginAs(userPage, user.email, original);
      await expect(userPage).toHaveURL(/\/pos$/);

      // Admin resets the password.
      const newPassword = "SetPassword-new-2";
      const resetRes = await admin.patch(`/api/users/${user.id}`, {
        data: { password: newPassword },
      });
      expect(resetRes.status(), "PATCH reset password").toBe(200);

      // A fresh context proves the OLD password is now rejected …
      const oldCtx = await browser.newContext();
      const oldPage = await oldCtx.newPage();
      await attemptLogin(oldPage, user.email, original);
      await expect(oldPage.getByText(INVALID_MSG)).toBeVisible();
      await expect(oldPage).toHaveURL(/\/login/);
      await oldCtx.close();

      // … and the NEW password is accepted.
      const newCtx = await browser.newContext();
      const newPage = await newCtx.newPage();
      await loginAs(newPage, user.email, newPassword);
      await expect(newPage).toHaveURL(/\/pos$/);
      await newCtx.close();
    } finally {
      await deactivateUser(admin, user.id);
      await userContext.close();
      await adminPage.close();
    }
  });
});
