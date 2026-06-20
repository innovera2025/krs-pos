---
description: Implement and verify the 4 "Phase 0 — stop the bleeding" items from the security audit
argument-hint: (no args)
---
Ensure all 4 **Phase 0** items from
`process/general-plans/references/pos-security-gap-audit_20-06-26.md` (the "TOP — ต้องแก้ทันที"
section) are done, then verify. Phase 0 was implemented on 2026-06-20 — use this to re-check / fix drift.

Checklist:
1. No real credentials in `README.md` (no admin email/password printed).
2. `GET` in `src/app/api/orders/route.ts` returns `cashier: { select: { id: true, name: true } }` (NOT `cashier: true`) — closes the password leak.
3. `docker-compose.yml` sources DB creds from env (`${POSTGRES_*}`), does NOT publish port 5432, and does not use the `postgres:postgres` default.
4. `package-lock.json` is committed and `public/.gitkeep` exists (so the Docker build works).

Current state:
!`echo "[1] README creds:"; grep -n "admin123\|admin@krs-pos.local" README.md || echo "    clean"; echo "[2] orders GET cashier:"; grep -n "cashier" src/app/api/orders/route.ts | head; echo "[3] compose:"; grep -nE "POSTGRES_PASSWORD|5432|^\s*ports" docker-compose.yml || echo "    (no ports / no hardcoded pw)"; echo "[4] lockfile:"; ls package-lock.json 2>/dev/null || echo "    MISSING"; echo "[4] public:"; ls public/.gitkeep 2>/dev/null || echo "    MISSING"`

For any unmet item, implement the fix per the audit (small, scoped). **Never commit real secrets.**
Then run `/verify`. Commit each fixed item as its own small commit with a meaningful message.
