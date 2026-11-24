#!/usr/bin/env node
/**
 * Mutation check: break each safety property on purpose and require the test
 * suite to fail. A mutation that leaves the tests green means the tests do not
 * actually guard that property.
 *
 *   node scripts/mutation-check.mjs            # all mutations
 *   node scripts/mutation-check.mjs expiry     # by id substring
 *
 * Every file is restored afterwards, also on failure or Ctrl-C.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const MUTATIONS = [
  {
    id: "expiry-not-checked",
    file: "src/plans.ts",
    from: "if (this.now().getTime() >= Date.parse(plan.expiresAt)) {",
    to: "if (false) {",
    expect: "plan_expired",
  },
  {
    id: "expiry-off-by-one",
    file: "src/plans.ts",
    from: "if (this.now().getTime() >= Date.parse(plan.expiresAt)) {",
    to: "if (this.now().getTime() > Date.parse(plan.expiresAt)) {",
    expect: "plan_expired",
  },
  {
    id: "hash-not-compared",
    file: "src/plans.ts",
    from: "if (!safeEqualHex(contentHash, expected) || !safeEqualHex(plan.contentHash, expected)) {",
    to: "if (false) {",
    expect: "hash_mismatch",
  },
  {
    id: "hash-trusts-stored-value",
    file: "src/plans.ts",
    from: "const expected = hashPlanContent(plan);",
    to: "const expected = plan.contentHash;",
    expect: "hash_mismatch (tampered plan)",
  },
  {
    id: "hash-ignores-args",
    file: "src/plans.ts",
    from: "      args: p.args,\n",
    to: "",
    expect: "hash_mismatch (tampered plan)",
  },
  {
    id: "plan-reusable",
    file: "src/plans.ts",
    from: '    this.burn(planId, "executed");',
    to: "",
    expect: "plan_already_used",
  },
  {
    id: "mismatch-does-not-burn",
    file: "src/plans.ts",
    from: '      this.burn(planId, "rejected");',
    to: "",
    expect: "plan_already_used after mismatch",
  },
  {
    id: "plan-key-not-bound",
    file: "src/plans.ts",
    from: "if (plan.keyId !== keyId) {",
    to: "if (false) {",
    expect: "plan_key_mismatch",
  },
  {
    id: "tool-scope-skipped",
    file: "src/app.ts",
    from: 'if (tool.scope !== "per-plan") requireScope(principal, tool.scope, tool.name);',
    to: "",
    expect: "forbidden",
  },
  {
    id: "execute-scope-skipped",
    file: "src/app.ts",
    from: "requireScope(principal, action.scope, `execute_plan(${pending.action})`);",
    to: "",
    expect: "forbidden on execute",
  },
  {
    id: "version-not-checked",
    file: "src/domain/orders.ts",
    from: "if (current.version !== expectedVersion) {",
    to: "if (false) {",
    expect: "stale_plan",
  },
  {
    id: "preview-writes",
    file: "src/app.ts",
    from: "const plan = plans.create(draft, principal.keyId);",
    to: "const plan = plans.create(draft, principal.keyId); opts.store.apply(draft.target.id, draft.target.version, () => {});",
    expect: "preview does not write",
  },
  {
    id: "audit-no-redaction",
    file: "src/audit.ts",
    from: 'out[k] = SECRET_KEY_PATTERN.test(k) ? "[REDACTED]" : redact(v, depth + 1);',
    to: "out[k] = redact(v, depth + 1);",
    expect: "redacted fields",
  },
  {
    id: "audit-skips-failures",
    file: "src/app.ts",
    from: "    try {\n      opts.audit.write({",
    to: "    if (outcome === \"ok\") try {\n      opts.audit.write({",
    expect: "denied/error lines",
  },
  {
    id: "audit-logs-anonymous",
    file: "src/app.ts",
    from: 'keyId: principal?.keyId ?? "anonymous",',
    to: 'keyId: "anonymous",',
    expect: "who",
  },
  {
    id: "audit-failure-ignored",
    file: "src/app.ts",
    from: 'console.error("[mcp-safe-write] audit write failed:", e);',
    to: 'console.error("[mcp-safe-write] audit write failed:", e); return result;',
    expect: "fail closed when audit fails",
  },
  {
    id: "scan-header-anywhere",
    file: "scripts/secret-scan.mjs",
    from: '} else if (inHunk && line.startsWith("+")) {',
    to: '} else if (inHunk && line.startsWith("+") && !line.startsWith("+++ ")) {',
    expect: "added '++ ' lines are scanned",
  },
  {
    id: "scan-deny-terms-ignored",
    file: "scripts/secret-scan.mjs",
    from: "const deny = denyTerms().map((t) => ({ t, lc: t.toLowerCase() }));",
    to: "const deny = [];",
    expect: "deny terms block",
  },
  {
    id: "scan-errors-not-blocking",
    file: "scripts/secret-scan.mjs",
    from: 'const failing = hits.filter((h) => h.grade === "error" || (strict && h.grade !== "error"));',
    to: 'const failing = hits.filter((h) => strict && h.grade !== "error");',
    expect: "error grade exits 1",
  },
];

/** Run the suite and return the full names of failing tests (empty = all green). */
function runTests() {
  let out;
  try {
    out = execFileSync("npx", ["vitest", "run", "--reporter=json"], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    out = e.stdout;
  }
  let report;
  try {
    report = JSON.parse(String(out));
  } catch {
    return ["<suite did not produce a report: syntax error or crash>"];
  }
  const failing = [];
  for (const f of report.testResults ?? []) {
    if (f.status === "failed" && !(f.assertionResults ?? []).length) failing.push(`${f.name}: ${f.message}`);
    for (const a of f.assertionResults ?? []) if (a.status === "failed") failing.push(a.fullName);
  }
  return failing;
}

const filter = process.argv[2];
const selected = MUTATIONS.filter((m) => !filter || m.id.includes(filter));
const originals = new Map();
const restore = () => {
  for (const [f, s] of originals) writeFileSync(f, s);
};
process.on("SIGINT", () => {
  restore();
  process.exit(130);
});

let survived = 0;
try {
  for (const m of selected) {
    const src = originals.get(m.file) ?? readFileSync(m.file, "utf8");
    originals.set(m.file, src);
    const n = src.split(m.from).length - 1;
    if (n !== 1) throw new Error(`[${m.id}] expected exactly 1 match in ${m.file}, found ${n} — update the mutation`);
    writeFileSync(m.file, src.replace(m.from, m.to));
    const failing = runTests();
    writeFileSync(m.file, src);
    const failed = failing.length > 0;
    console.log(`${failed ? "killed  " : "SURVIVED"}  ${m.id.padEnd(26)} (guards: ${m.expect})`);
    for (const t of failing.slice(0, 3)) console.log(`            ✗ ${t}`);
    if (failing.length > 3) console.log(`            … and ${failing.length - 3} more`);
    if (!failed) survived++;
  }
} finally {
  restore();
}
console.log(`\n${selected.length - survived}/${selected.length} mutations killed`);
process.exit(survived ? 1 : 0);
