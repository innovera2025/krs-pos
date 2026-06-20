---
description: Run the krs-pos verification gates (type-check + build) and summarize pass/fail
argument-hint: (no args)
allowed-tools: Bash(npm run type-check), Bash(npm run build), Bash(npm run prisma:generate)
---
Run the project's verification gates and report the result clearly.

1. Run `npm run type-check` (tsc --noEmit). If it errors because the Prisma client is missing/stale, run `npm run prisma:generate` once, then retry.
2. Run `npm run build`.
3. Summarize: **type-check = PASS/FAIL** and **build = PASS/FAIL**. If either failed, quote the key error lines and propose the smallest fix.

Lint is not configured yet — skip it. (See `process/context/tests/all-tests.md`.)
