# CLAUDE.md — krs-pos

Project-specific guidance for **KRS POS**. (The global RIPER-5 / orchestration rules still apply on top of this.)

## Read context first
For any substantial task, read **`process/context/all-context.md` FIRST** — it routes to the stack,
conventions, and the deeper context groups (`database/`, `container/`, `tests/`, `planning/`).
Roadmap + the verified security/best-practice gaps live in
`process/general-plans/references/pos-security-gap-audit_20-06-26.md`.

## Stack
Next.js **14** (App Router) · TypeScript **5** (strict) · React 18 · Tailwind 3 · Prisma **5** +
PostgreSQL **16** · Node **20** · npm. Import alias `@/*` → `./src/*`. Prisma client is a singleton at
`src/lib/prisma.ts` (import `{ prisma }`; only `prisma/seed.ts` makes its own client).

## Verify before "done"
A change is NOT done until BOTH pass:
- `npm run type-check`  (tsc --noEmit)
- `npm run build`

Run `/verify` to do both. **Lint is not configured yet** (`next lint` has no ESLint config) — skip it.
There is no automated test runner yet (see `process/context/tests/all-tests.md`).

## Money & stock = highest-risk area — be careful
This app handles cash and inventory. Two recurring hazards:
- **Money:** prices/totals are Prisma `Decimal(10,2)` but current code does JS **float** math
  (`Number(...)`). Prefer Decimal / integer-satang end-to-end; never trust client-sent amounts
  (`taxRate`, `discount`, `amountPaid`) — recompute server-side.
- **Stock:** `product.stock` can go **negative** (no sufficiency guard, race-prone). Decrement
  atomically (`updateMany where stock gte qty`) and validate quantity as a positive integer.

Treat `src/app/api/orders/route.ts` (checkout) as the most sensitive file in the repo. Run the
`pricing-tester` agent after touching it.

## Git
Commit in small, scoped chunks with meaningful messages (`type(scope): summary`). **Never commit real
secrets** — DB credentials and keys come from a git-ignored `.env` (`.env.example` documents the names
only). `.claude/settings.local.json` is personal and git-ignored.

## Keep context in sync
If durable structure/knowledge changes (deps, Prisma schema, routes, env vars, Docker/compose,
verify/build commands, context groups), update the smallest relevant file under `process/context/`
(and `all-context.md` if routing/stack/env changed). Run `/refresh-context` or use the
`context-maintainer` agent. Do not touch `.seed` companion files.

## UI / design
Design mockups for this app live in `design/`. For any UI/frontend work, these files are the
source of truth and must be inspected before coding — do not invent layouts from memory or build from
smoke-test shells.

Required design references:
- `design/Simple POS.dc.html` — original full POS design/function inventory. Use this to understand
  required screens, states, flows, copy, and POS domain behavior.
- `design/KRS POS Taste Redesign.html` — the approved redesign direction created by Joi. New UI should
  follow this visual language: cashier-first layout, compact left rail, large searchable product grid,
  clear right-side cart/payment panel, Thai-first bilingual microcopy, IBM Plex Sans Thai/Mono,
  forest-green/mint operational palette, restrained borders/shadows, and modal/payment patterns.

Implementation rule: preserve the functions/states from `Simple POS.dc.html` while redesigning them in
the style of `KRS POS Taste Redesign.html`. If a function exists in the original design but is missing
from the Taste redesign prototype, do not drop it silently — port the function/state into the redesign
language or document the gap before implementation.

The folder also contains `design/_ds/`, a design-system token set (colors, typography, spacing; light +
dark). **Caveat:** those tokens were authored for a different product ("pguard"). They may be used only
as aesthetic/reference material for Thai-first operational UI unless the owner explicitly approves
deriving a KRS POS design system from them. Do not treat pguard-specific semantics (guard dispatch,
map pins, guard live-status colors) as KRS POS product requirements.

## Project tooling (`.claude/`)
- **Commands:** `/verify` · `/phase0` · `/refresh-context` · `/smoke`
- **Agents:** `security-reviewer` · `pricing-tester` · `context-maintainer`
- **Hook:** after editing any `.ts`/`.tsx`, `npm run type-check` runs automatically and reports
  errors (non-blocking).
