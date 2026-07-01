/**
 * kioskMode — client-side kiosk/onboarding state for the silent-print onboarding
 * (Plan A). Backed entirely by localStorage; every function is SSR-safe (guards
 * `typeof window`), so calling any of these during a server render is a harmless
 * no-op that returns a falsy default.
 *
 * Two independent flags:
 *  - STORAGE_KEY_KIOSK    — set when the POS was opened via the kiosk shortcut
 *    (the `.bat` appends `?kiosk=1` to the --app URL). Persisted on first load so
 *    later in-app navigations that drop the query param still read it. Its presence
 *    suppresses the onboarding modal (a kiosk session already has silent print).
 *  - STORAGE_KEY_DISMISSED — set when the operator clicks "ตั้งค่าเสร็จแล้ว" in the
 *    modal. Permanently suppresses the modal on this browser.
 *
 * The onboarding modal shows only when NEITHER flag is set (a normal browser that
 * has never completed setup).
 */

export const STORAGE_KEY_KIOSK = "krspos_kiosk_mode";
export const STORAGE_KEY_DISMISSED = "krspos_silentprint_dismissed";

/**
 * Persist the kiosk flag if the current URL carries `?kiosk=1` (the kiosk shortcut
 * signal). MUST be called BEFORE {@link shouldShowOnboardingModal} on every page
 * mount. Side-effect only — a no-op when not in the browser or when the param is
 * absent. Never CLEARS the flag: subsequent client navigations lose the query
 * param, but the persisted flag must survive them.
 */
export function persistKioskModeIfFlagged(): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  if (params.get("kiosk") === "1") {
    localStorage.setItem(STORAGE_KEY_KIOSK, "1");
  }
}

/** True when this browser has been marked as a kiosk session. SSR → false. */
export function isKioskMode(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(STORAGE_KEY_KIOSK) === "1";
}

/** True when the operator permanently dismissed the onboarding modal. SSR → false. */
export function isDismissed(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(STORAGE_KEY_DISMISSED) === "1";
}

/** Permanently dismiss the onboarding modal on this browser. SSR → no-op. */
export function markDismissed(): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY_DISMISSED, "1");
}

/**
 * Pure read: whether the onboarding modal should appear. True only for a normal
 * browser that is neither a kiosk session nor previously dismissed. Safe on the
 * server (both sub-reads return false → returns false). Does NOT persist the kiosk
 * flag — call {@link persistKioskModeIfFlagged} first.
 */
export function shouldShowOnboardingModal(): boolean {
  return !isKioskMode() && !isDismissed();
}
