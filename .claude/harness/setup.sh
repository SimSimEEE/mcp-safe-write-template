#!/bin/bash
# Lay out harness-engine for THIS project under .claude/ (project scope, not ~/.claude).
#
#   bash .claude/harness/setup.sh          # or: npm run harness:setup
#
# What it does
#   1. Fetches harness-engine at the commit pinned in .claude/harness/ENGINE_PIN into
#      .claude/harness-engine/ (git-ignored) and checks ENGINE_VERSION matches the pin (fail closed).
#   2. Copies the engine's agents/, skills/, hooks/ into .claude/{agents,skills,hooks}/ (git-ignored),
#      then this overlay's agents on top (same name wins), like the engine's own `install.sh --copy`.
#   3. Points the engine at this overlay (.claude/harness: categories/, profiles/) via the copied
#      skills/preflight/config.json.
#
# What it does NOT do: touch ~/.claude or ~/.claude/settings.json. Hook registration for this project
# lives in the tracked .claude/settings.json (through .claude/harness/hook.sh).
# Why not the engine's install.sh: it installs user-wide and merges into ~/.claude/settings.json; this
# template must work as a self-contained repo (cloud sessions, client deliveries). See README.md here.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
OV="$ROOT/.claude/harness"
ENGINE="$ROOT/.claude/harness-engine"
URL="${HARNESS_ENGINE_URL:-https://github.com/SimSimEEE/harness-engine.git}"

pin_version=$(sed -n 's/^version=//p' "$OV/ENGINE_PIN")
pin_commit=$(sed -n 's/^commit=//p' "$OV/ENGINE_PIN")
[[ "$pin_commit" =~ ^[0-9a-f]{40}$ ]] || { echo "ENGINE_PIN: commit must be a 40-char sha" >&2; exit 2; }

if [ ! -d "$ENGINE/.git" ]; then
    git init -q "$ENGINE"
    git -C "$ENGINE" remote add origin "$URL"
fi
if [ "$(git -C "$ENGINE" rev-parse -q --verify HEAD 2>/dev/null || true)" != "$pin_commit" ]; then
    echo "harness: fetching harness-engine @ ${pin_commit:0:12}"
    git -C "$ENGINE" fetch -q --depth 1 origin "$pin_commit"
    git -C "$ENGINE" -c advice.detachedHead=false checkout -q --detach FETCH_HEAD
fi
got_version=$(head -n1 "$ENGINE/skills/preflight/ENGINE_VERSION" | tr -d '[:space:]')
if [ "$got_version" != "$pin_version" ]; then
    echo "harness: engine version $got_version != pinned $pin_version — refusing (bump ENGINE_PIN deliberately)" >&2
    exit 3
fi

for d in agents skills hooks; do
    rm -rf "${ROOT:?}/.claude/$d"
    mkdir -p "$ROOT/.claude/$d"
    cp -R "$ENGINE/$d/." "$ROOT/.claude/$d/"
done
for f in "$OV"/agents/*.md; do
    [ -e "$f" ] && cp "$f" "$ROOT/.claude/agents/"
done
chmod +x "$ROOT"/.claude/hooks/*.sh "$ROOT"/.claude/skills/preflight/*.sh

# Machine-local engine config (git-ignored with the rest of .claude/skills): point at this overlay.
python3 - "$ENGINE/skills/preflight/config.example.json" "$ROOT/.claude/skills/preflight/config.json" "$OV" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))
c['overlayDir'] = sys.argv[3]
c['vaultDir'] = ''          # this project has no knowledge vault
json.dump(c, open(sys.argv[2], 'w'), ensure_ascii=False, indent=2)
PY

# Drift check for the overridden agent.
base_want=$(cat "$OV/agents/test-runner.base.sha256" 2>/dev/null || true)
base_got=$(sha256sum "$ENGINE/agents/test-runner.md" | cut -d' ' -f1)
if [ -n "$base_want" ] && [ "$base_want" != "$base_got" ]; then
    echo "harness: WARNING engine agents/test-runner.md changed since the overlay override was made;" >&2
    echo "         re-apply the jest->vitest diff to .claude/harness/agents/test-runner.md and update test-runner.base.sha256" >&2
fi

echo "harness: ready — engine $got_version @ ${pin_commit:0:12}, overlay $OV"
echo "harness: category for this repo: $("$ROOT/.claude/skills/preflight/category.sh" "$ROOT" 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("category"), "| profile:", (d.get("profile") or {}).get("path"))' 2>/dev/null || echo '?')"
