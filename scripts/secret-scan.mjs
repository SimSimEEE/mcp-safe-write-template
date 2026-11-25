#!/usr/bin/env node
/**
 * Deterministic secret / leak scanner for this repository (no network, no LLM).
 *
 *   node scripts/secret-scan.mjs --staged          # added lines of the staged diff (pre-commit)
 *   node scripts/secret-scan.mjs --range A..B      # added lines between two revisions (CI on PRs)
 *   node scripts/secret-scan.mjs --all             # every tracked file (CI, before going public)
 *   node scripts/secret-scan.mjs --history         # deny terms in every file version and commit
 *                                                  # message ever reachable (before going public)
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
 *
 * Known-safe example values (public demo keys, redaction markers, test fixtures) are listed once,
 * in the `[allowlist] regexes` of `.gitleaks.toml`, and shared with gitleaks. They silence only
 * suspect/warning findings whose matched text contains an allowlisted value — never error grade,
 * so an allowlisted value cannot hide a real key on the same line.
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

/** The `[allowlist] regexes = [...]` entries of .gitleaks.toml (TOML literal strings only). */
function sharedAllowlist() {
  if (!existsSync(".gitleaks.toml")) return [];
  const toml = readFileSync(".gitleaks.toml", "utf8");
  const section = toml.split(/^\[allowlist\]\s*$/m)[1]?.split(/^\[/m)[0] ?? "";
  const list = section.match(/^regexes\s*=\s*\[([\s\S]*?)^\]/m)?.[1] ?? "";
  return [...list.matchAll(/'''([\s\S]*?)'''/g)].map((m) => {
    try {
      return new RegExp(m[1]);
    } catch {
      console.error(`.gitleaks.toml: allowlist regex does not compile: ${m[1]}`);
      process.exit(2);
    }
  });
}
const SHARED_ALLOW = sharedAllowlist();

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
const mode = argv.find((a) => ["--staged", "--all", "--range", "--history"].includes(a));
if (!mode) {
  console.error("usage: secret-scan.mjs --staged | --all | --range <a>..<b> | --history [--strict]");
  process.exit(2);
}
const rangeArg = mode === "--range" ? argv[argv.indexOf("--range") + 1] : undefined;
if (mode === "--range" && !rangeArg) {
  console.error("--range needs <a>..<b>");
  process.exit(2);
}

const deny = denyTerms().map((t) => ({ t, lc: t.toLowerCase() }));
/** Paths are printed, and CI logs can be public: replace any deny term inside a path with ***. */
const show = (path) =>
  deny.reduce((p, d) => p.replace(new RegExp(d.t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "***"), path);
if (mode === "--history") process.exit(scanHistory(deny));
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
      if (p.grade !== "error" && SHARED_ALLOW.some((a) => a.test(m[0]))) continue;
      hits.push({ file: f.path, line: n, pattern: p.name, grade: p.grade });
    }
    const lc = text.toLowerCase();
    for (const d of deny) if (lc.includes(d.lc)) hits.push({ file: f.path, line: n, pattern: "deny-term", grade: "error" });
  }
}

const failing = hits.filter((h) => h.grade === "error" || (strict && h.grade !== "error"));
for (const h of hits) console.log(`${h.grade.padEnd(7)} ${show(h.file)}:${h.line}  ${h.pattern}`);
console.log(
  `secret-scan ${mode}: ${files.length} files, ${scannedLines} lines, ${deny.length} deny terms, ` +
    `${hits.length} findings, ${failing.length} blocking`,
);
process.exit(failing.length ? 1 : 0);

/**
 * --history: deny terms only, across everything a clone of this repo would contain — every
 * version of every file reachable from any ref (deleted files included), every path, and every
 * commit message. Secret patterns in history are gitleaks' job in CI. Returns the exit code.
 */
function scanHistory(terms) {
  if (!terms.length) {
    console.log("secret-scan --history: 0 deny terms, nothing to check (set DENY_TERMS or .deny-terms)");
    return 0;
  }
  const out = [];
  const match = (text) => {
    const lc = text.toLowerCase();
    return terms.some((d) => lc.includes(d.lc));
  };

  // First path each blob was seen at, from `rev-list --objects` (object id, space, path).
  const pathOf = new Map();
  for (const line of git("rev-list", "--objects", "--all").split("\n")) {
    const i = line.indexOf(" ");
    if (i > 0 && !pathOf.has(line.slice(0, i))) pathOf.set(line.slice(0, i), line.slice(i + 1));
  }
  const ids = [...pathOf.keys()];
  const types = execFileSync("git", ["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
    input: ids.join("\n") + "\n",
    maxBuffer: 256 * 1024 * 1024,
  })
    .toString("utf8")
    .split("\n");
  const blobs = types.filter((l) => l.endsWith(" blob")).map((l) => l.split(" ")[0]);

  // Read all blobs in one process: "<id> blob <size>\n<content>\n" per object.
  const buf = blobs.length
    ? execFileSync("git", ["cat-file", "--batch"], { input: blobs.join("\n") + "\n", maxBuffer: 1024 * 1024 * 1024 })
    : Buffer.alloc(0);
  let pos = 0;
  for (const id of blobs) {
    const nl = buf.indexOf(10, pos);
    const size = Number(buf.subarray(pos, nl).toString("utf8").split(" ")[2]);
    const content = buf.subarray(nl + 1, nl + 1 + size);
    pos = nl + 1 + size + 1;
    const path = pathOf.get(id) ?? id;
    if (match(path)) out.push(`error   ${show(path)} (blob ${id.slice(0, 7)})  deny-term(path)`);
    if (!content.includes(0) && match(content.toString("utf8"))) {
      out.push(`error   ${show(path)} (blob ${id.slice(0, 7)})  deny-term`);
    }
  }

  const commits = git("log", "--all", "--format=%H%x00%B%x01").split("\x01");
  let nCommits = 0;
  for (const c of commits) {
    const [id, body] = c.replace(/^\n/, "").split("\0");
    if (!id) continue;
    nCommits++;
    if (match(body ?? "")) out.push(`error   <commit message ${id.slice(0, 7)}>  deny-term`);
  }

  for (const l of out) console.log(l);
  console.log(
    `secret-scan --history: ${blobs.length} file versions, ${nCommits} commits, ${terms.length} deny terms, ` +
      `${out.length} findings, ${out.length} blocking`,
  );
  return out.length ? 1 : 0;
}
