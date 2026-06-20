# Planning Context

This file is the canonical planning context entrypoint for krs-pos.

Use it after `process/context/all-context.md` when the task needs plan-shape calibration,
planning conventions, or implementation-plan examples.

## Scope

This group covers:

- example plan shapes (SIMPLE vs COMPLEX)
- plan-shape calibration for new work
- durable planning references that should not live at the `process/context/` root

It does not cover:

- active implementation plans → `process/general-plans/active/` (or `process/features/*/active/`)
- feature reports → `process/general-plans/reports/` or `process/features/*/reports/`
- backlog items → `process/general-plans/backlog/`

## Read When

Read this entrypoint when:

- creating a new plan with the `vc-generate-plan` skill / `vc-plan-agent`
- deciding whether work should be `SIMPLE` (one session) or `COMPLEX` (multi-phase)
- comparing an active plan against the repo's example plan shapes

## Quick Routing

The canonical example PRDs live in the development-protocols references (shared by Claude + Codex):

- use `process/development-protocols/references/example-simple-prd.md` to calibrate a one-session plan
- use `process/development-protocols/references/example-complex-prd.md` to calibrate a complex / multi-phase plan
- use `process/development-protocols/references/program-goal-charter-template.md` for a large multi-phase program charter

## Source Paths

- `process/development-protocols/references/example-simple-prd.md`
- `process/development-protocols/references/example-complex-prd.md`
- `process/development-protocols/references/program-goal-charter-template.md`
- `process/development-protocols/plan-lifecycle.md` — plan statuses, archiving, resume handoff

## Update Triggers

Update this group when:

- the plan artifact contract changes
- `vc-generate-plan` expects different plan sections or statuses
- the example plan shapes move, split, or become stale
