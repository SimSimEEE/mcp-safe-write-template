#!/bin/bash
# Project-scope hook wrapper: runs a harness-engine hook from .claude/hooks/ (laid out by setup.sh).
#   usage (from .claude/settings.json): hook.sh <engine-hook-script>
#
# - Engine not set up yet -> no-op (exit 0). The base layer (git hooks + CI) still gates commits;
#   the gate hook prints a one-line reminder so the gap is visible, not silent.
# - Engine already registered user-wide (~/.claude/settings.json mentions the same hook) -> no-op,
#   so the same hook does not run twice. The user-wide install then decides.
name="${1:?usage: hook.sh <hook-script>}"
case "$name" in */*|*..*) echo "hook.sh: bad hook name" >&2; exit 0 ;; esac
ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
target="$ROOT/.claude/hooks/$name"

if grep -qs "/hooks/$name" "$HOME/.claude/settings.json"; then
    exit 0
fi
if [ ! -x "$target" ]; then
    if [ "$name" = preflight-gate.sh ]; then
        echo "harness-engine is not set up for this project (npm run harness:setup); only git hooks + CI gate this commit" >&2
    fi
    exit 0
fi
exec "$target"
