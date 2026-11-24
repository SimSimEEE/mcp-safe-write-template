#!/bin/bash
# SessionStart: in Claude Code cloud sessions (fresh container every time) lay out the pinned engine.
# Local sessions are left alone — run `npm run harness:setup` yourself once.
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
[ -x "$ROOT/.claude/hooks/preflight-gate.sh" ] && exit 0
bash "$ROOT/.claude/harness/setup.sh" >&2 || echo "harness setup failed; git hooks + CI still apply" >&2
exit 0
