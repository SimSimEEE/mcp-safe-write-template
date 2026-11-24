#!/usr/bin/env node
/**
 * Deterministic secret / leak scanner for this repository (no network, no LLM).
 *
 *   node scripts/secret-scan.mjs --staged          # added lines of the staged diff (pre-commit)
 *   node scripts/secret-scan.mjs --range A..B      # added lines between two revisions (CI on PRs)
 *   node scripts/secret-scan.mjs --all             # every tracked file (CI, before going public)
 *
 * Grades (taken from harness-engine's secret-patterns.json v4, see NOTICE):
 *   error    -> exit 1          suspect / warning -> printed, exit 0 (use --strict to fail)
 *
 * Deny terms: names that must never appear in this repo (e.g. an employer, a
 * client, an internal project). They are NOT stored in the repo — that would
 * leak them. Provide them via the DENY_TERMS env var (comma separated; in CI a
 * repository secret) and/or a git-ignored `.deny-terms` file (one per line).
 *
 * Values are never printed: only file, line, pattern name and grade.
 * A line containing `secret-scan: allow` is skipped (use sparingly, review in PR).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

// Ported from harness-engine skills/preflight/secret-patterns.json (version 4, Apache-2.0).
// Python inline (?i) became the JS "i" flag; regex bodies are otherwise unchanged.
const PATTERNS = [
  { name: "pem-private-key", grade: "error", re: /-----BEGIN ([A-Z]+ )?PRIVATE KEY-----/ },
  { name: "payment-live-key", grade: "error", re: /\b[sp]k_live_[A-Za-z0-9]{20,}/ },
  { name: "jwt", grade: "error", re: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/ },
  { name: "aws-access-key", grade: "error", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "aws-temp-key", grade: "error", re: /\bASIA[0-9A-Z]{16}\b/ },
  { name: "aws-secret-key", grade: "error", re: /aws_?secret_?access_?key\W{0,4}[A-Za-z0-9/+=]{40}/i },
  {
    name: "issued-token",
    grade: "error",
    re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bxox[abpr]-[A-Za-z0-9-]{10,}|\bglpat-[A-Za-z0-9_-]{20,}/,
  },
  { name: "password-assign", grade: "error", re: /password\s*[:=]\s*['"][^'"]{4,}['"]/i },
  {
    name: "secret-like-assign",
    grade: "suspect",
    re: /(secret[_-]?(?:access[_-]?)?key|session[_-]?(?:token|key)|access[_-]?(?:token|key)|secret|token|api[_-]?key|private[_-]?key|hmac|passw(?:or)?d|pwd)[A-Za-z0-9_]*\s*(?:=>|[:=])\s*['"][^'"\s]{8,}['"]/i,
  },
  {
    name: "secret-like-quoted-key",
    grade: "suspect",
    re: /(secret[_-]?(?:access[_-]?)?key|session[_-]?(?:token|key)|access[_-]?(?:token|key)|secret|token|api[_-]?key|private[_-]?key|hmac|passw(?:or)?d|pwd)[A-Za-z0-9_-]*['"]\]?\s*(?:=>|[:=])\s*['"][^'"\s]{8,}['"]/i,
  },
  { name: "env-key-secret-plain", grade: "suspect", re: /^\s*[A-Z0-9_]*(_KEY|_SECRET)\s*[:=]\s*['"]?[^'"\s#]{8,}/i },
  { name: "password-assign-unquoted", grade: "suspect", re: /(password|passwd|pwd)[A-Za-z0-9_]*\s*[:=]\s*[^\s'"#][^\s#]{5,}/i },
  { name: "url-embedded-credentials", grade: "suspect", re: /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/ },
  { name: "payment-test-key", grade: "suspect", re: /\b[sp]k_test_[A-Za-z0-9]{10,}/ },
  { name: "machine-abs-path", grade: "warning", re: /\/(Users|home)\/[A-Za-z0-9._-]+\// },
  { name: "email-address", grade: "warning", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
];

// Same list as harness-engine sensitivePaths; matched against the repo-relative path.
const SENSITIVE_PATHS = [
  "env/**", "*.env", "*.env.*", "**/config/**/*.yml", "**/config/**/*.yaml", "**/seed*/**", "**/fixtures/**",
  "*.pem", "*.key", "credentials*", "*.p12", "*.pfx", "*.jks", "*.keystore", "id_rsa*", "id_ed25519*",
];

// Addresses that are fine to publish (attribution lines, placeholders).
const EMAIL_ALLOW = [/^noreply@anthropic\.com$/i, /@example\.(com|org|net)$/i, /^git@github\.com$/i];

function globToRe(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
const SENSITIVE_RES = SENSITIVE_PATHS.map((g) => ({ g, re: globToRe(g), base: !g.includes("/") }));
function sensitive(path) {
  const base = path.split("/").pop();
  return SENSITIVE_RES.find((s) => s.re.test(s.base ? base : path))?.g;
}

function denyTerms() {
  const terms = (process.env.DENY_TERMS ?? "").split(",");
  if (existsSync(".deny-terms")) terms.push(...readFileSync(".deny-terms", "utf8").split("\n"));
  return [...new Set(terms.map((t) => t.trim()).filter((t) => t && !t.startsWith("#")))];
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/** Returns [{ path, lines: [{ n, text }] }] for the chosen mode. */
function collect(mode, arg) {
  if (mode === "--all") {
    return git("ls-files", "-z")
      .split("\0")
      .filter(Boolean)
      .filter((p) => existsSync(p))
      .map((path) => {
        const buf = readFileSync(path);
        if (buf.includes(0)) return { path, lines: [], binary: true };
        return { path, lines: buf.toString("utf8").split("\n").map((text, i) => ({ n: i + 1, text })) };
      });
  }
  const diffArgs = mode === "--staged" ? ["diff", "--cached"] : ["diff", arg];
  // Paths come from a NUL-separated list, never from diff headers: git quotes names with non-ASCII
  // characters and appends a TAB to names with spaces there, which would break the path checks.
  const paths = git(...diffArgs, "--name-only", "-z", "--diff-filter=ACMR").split("\0").filter(Boolean);
  return paths.map((path) => {
    const out = git(...diffArgs, "-U0", "--no-color", "--no-ext-diff", "--text", "--", path);
    return { path, lines: addedLines(out) };
  });
}

/** Added lines of a single-file `-U0` diff, with their line numbers in the new file. */
function addedLines(out) {
  const lines = [];
  let n = 0;
  // Before the first `@@` everything is header. Inside a hunk, an added line whose text starts with
  // "++ " looks like a `+++ ` header and must still be scanned as content.
  let inHunk = false;
  for (const line of out.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      n = Number(/\+(\d+)/.exec(line)?.[1] ?? 0);
    } else if (inHunk && line.startsWith("+")) {
      lines.push({ n, text: line.slice(1) });
      n++;
    }
  }
  return lines;
}

const argv = process.argv.slice(2);
const strict = argv.includes("--strict");
const mode = argv.find((a) => ["--staged", "--all", "--range"].includes(a));
if (!mode) {
  console.error("usage: secret-scan.mjs --staged | --all | --range <a>..<b> [--strict]");
  process.exit(2);
}
const rangeArg = mode === "--range" ? argv[argv.indexOf("--range") + 1] : undefined;
if (mode === "--range" && !rangeArg) {
  console.error("--range needs <a>..<b>");
  process.exit(2);
}

const deny = denyTerms().map((t) => ({ t, lc: t.toLowerCase() }));
const hits = [];
let scannedLines = 0;
const files = collect(mode, rangeArg);
for (const f of files) {
  const sp = sensitive(f.path);
  if (sp) hits.push({ file: f.path, line: 0, pattern: `sensitive-path(${sp})`, grade: "error" });
  if (f.binary) continue;
  for (const d of deny) {
    if (f.path.toLowerCase().includes(d.lc)) hits.push({ file: f.path, line: 0, pattern: "deny-term(path)", grade: "error" });
  }
  for (const { n, text } of f.lines) {
    scannedLines++;
    if (text.includes("secret-scan: allow")) continue;
    for (const p of PATTERNS) {
      const m = p.re.exec(text);
      if (!m) continue;
      if (p.name === "email-address" && EMAIL_ALLOW.some((a) => a.test(m[0]))) continue;
      hits.push({ file: f.path, line: n, pattern: p.name, grade: p.grade });
    }
    const lc = text.toLowerCase();
    for (const d of deny) if (lc.includes(d.lc)) hits.push({ file: f.path, line: n, pattern: "deny-term", grade: "error" });
  }
}

const failing = hits.filter((h) => h.grade === "error" || (strict && h.grade !== "error"));
for (const h of hits) console.log(`${h.grade.padEnd(7)} ${h.file}:${h.line}  ${h.pattern}`);
console.log(
  `secret-scan ${mode}: ${files.length} files, ${scannedLines} lines, ${deny.length} deny terms, ` +
    `${hits.length} findings, ${failing.length} blocking`,
);
process.exit(failing.length ? 1 : 0);
