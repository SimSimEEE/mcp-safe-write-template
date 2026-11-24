# ts-mcp-server — this template and projects forked from it (TypeScript MCP server, vitest, mutation check).
#
# Overlay category for harness-engine (contract: the "카테고리" section of skills/preflight/classify.sh).
# The engine's default test-runner lane assumes jest; this category hands the lane the exact regression
# commands instead, and .claude/harness/agents/test-runner.md swaps the jest steps for vitest.


def match(ctx):
    signals = ['package.json', 'vitest.config.ts', 'scripts/mutation-check.mjs', 'scripts/secret-scan.mjs']
    return signals if all(ctx.snap_has(s) for s in signals) else []


_CODE_PREFIXES = ('src/', 'tests/', 'scripts/')
_CODE_FILES = ('package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json',
               'vitest.config.ts', 'eslint.config.js')


# `marker` is matched by receipt.sh against the commands test-runner actually ran, as the command head at
# command position (after `cd … &&`, `timeout N`, env assignments). So it must be the whole head
# (`npx vitest run`, `node scripts/x.mjs`), not a word in the middle of the command.
def suites(ctx, changed):
    """Regression commands the test-runner lane must run (all of them, in the gate's snapshot)."""
    if not match(ctx):
        return []
    trig = [f for f in changed if f.startswith(_CODE_PREFIXES) or f in _CODE_FILES]
    if not trig:
        return []
    t = ctx.snap_token
    out = [
        {'name': 'vitest', 'marker': 'npx vitest run', 'cmd': f'cd {t} && npx vitest run', 'why': trig},
        {'name': 'secret-scan', 'marker': 'node scripts/secret-scan.mjs',
         'cmd': f'cd {t} && node scripts/secret-scan.mjs --all', 'why': trig},
    ]
    safety = [f for f in trig if f.startswith(('src/', 'tests/')) or f == 'scripts/mutation-check.mjs']
    if safety:
        # Tests must still catch every deliberately broken safety rule.
        out.append({'name': 'mutation-check', 'marker': 'node scripts/mutation-check.mjs',
                    'cmd': f'cd {t} && node scripts/mutation-check.mjs', 'why': safety})
    return out


# Real key files must never be committed (only config/keys.example.json is).
SECRET_SENSITIVE_EXTRA = ('config/keys.json',)
