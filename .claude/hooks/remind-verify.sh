#!/usr/bin/env bash
# UserPromptSubmit hook (krs-pos): when the user's prompt is about committing/pushing,
# inject a non-blocking reminder to run the verify gates first. Never blocks.
set -uo pipefail

input="$(cat)"
prompt="$(printf '%s' "$input" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).prompt||"")}catch(e){process.stdout.write("")}})' 2>/dev/null)"

if printf '%s' "$prompt" | grep -iqE 'commit|push|merge|pull request'; then
  node -e '
    const ctx = "Reminder (krs-pos): before committing/pushing, ensure `npm run type-check` and `npm run build` pass (run /verify), and that no real secrets are staged. Lint is not configured yet — skip it.";
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ctx } }));
  '
fi
exit 0
