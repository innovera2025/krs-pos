---
description: Read the latest git diff and update the relevant process/context/ docs so they stay accurate
argument-hint: [base-ref] (optional; defaults to HEAD~1)
---
Inspect recent changes and update the project context docs so they never drift from the code.

Recent history:
!`git log --oneline -10`

Changed files & diffstat (vs ${ARGUMENTS:-HEAD~1}):
!`git diff --stat ${ARGUMENTS:-HEAD~1} 2>/dev/null || git diff --cached --stat`
!`git status --short`

Task:
1. Read `process/context/all-context.md` and the relevant group entrypoint(s) under `process/context/` (`database/`, `container/`, `tests/`, `planning/`).
2. For any **durable** structural/knowledge change in the diff — new/removed deps, Prisma schema/model/enum changes, new/removed routes, env var changes, Docker/compose changes, changes to verify/build commands, or new context groups — update the **smallest** relevant context file. Update `all-context.md` only if routing, stack, env, groups, or repo structure changed.
3. Do NOT document transient or feature-specific details (those belong in plans/reports). Leave `.seed` companion files untouched. Never invent facts — verify against the code.
4. Summarize which context files you changed and why, then recommend running the `vc-audit-context` skill to validate wiring.

(For deeper/structural work you may delegate to the `context-maintainer` agent.)
