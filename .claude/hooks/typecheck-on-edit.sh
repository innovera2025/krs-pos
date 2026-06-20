#!/usr/bin/env bash
# PostToolUse hook (krs-pos): after an Edit/Write/MultiEdit on a .ts/.tsx file,
# run `npm run type-check` and report any errors back to Claude WITHOUT blocking.
# PostToolUse cannot block (the edit already happened) — we only inject context.
set -uo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$PROJECT_DIR" 2>/dev/null || exit 0

input="$(cat)"

# Extract the edited file path from the hook stdin JSON (tool_input.file_path), via node (always present in this repo).
file="$(printf '%s' "$input" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);process.stdout.write(((j.tool_input||{}).file_path)||"")}catch(e){process.stdout.write("")}})' 2>/dev/null)"

# Only react to TypeScript sources; anything else is a no-op so normal edits stay fast.
case "$file" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

# Run the project's type-check gate. Capture output; never let its failure abort this script.
out="$(npm run --silent type-check 2>&1)"; status=$?

if [ "$status" -eq 0 ]; then
  exit 0   # clean — stay silent (non-noisy)
fi

# Type errors found: report them to Claude as non-blocking context.
ERR="$(printf '%s' "$out" | tail -n 40)" FILE="$file" node -e '
  const ctx = "⚠️ type-check FAILED after editing " + process.env.FILE +
    " — `npm run type-check` (tsc --noEmit):\n" + process.env.ERR +
    "\n\nThis is non-blocking, but fix the type errors before treating the work as done.";
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: ctx } }));
'
exit 0
