#!/bin/bash
# Project-scope hook wrapper: runs a harness-engine hook from .claude/hooks/ (laid out by setup.sh).
#   usage (from .claude/settings.json): hook.sh <engine-hook-script>
#
# - Engine not set up -> no-op (exit 0). The Claude Code layer is opt-in: it is on only after
#   `npm run harness:setup` and off again after `npm run harness:off`. The base layer (git hooks + CI)
#   gates commits either way.
# - Engine already registered user-wide (~/.claude/settings.json mentions the same hook) -> no-op,
#   so the same hook does not run twice. The user-wide install then decides.
name="${1:?usage: hook.sh <hook-script>}"
case "$name" in */*|*..*) echo "hook.sh: bad hook name" >&2; exit 0 ;; esac
ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
target="$ROOT/.claude/hooks/$name"

if grep -qs "/hooks/$name" "$HOME/.claude/settings.json"; then
    exit 0
fi
[ -x "$target" ] || exit 0
exec "$target"
