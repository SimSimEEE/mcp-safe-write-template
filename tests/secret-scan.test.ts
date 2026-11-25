import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCANNER = resolve("scripts/secret-scan.mjs");

function repoWith(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "scan-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  g("init", "-q");
  for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
  g("add", ".");
  return dir;
}

function scan(dir: string, mode: string, env: Record<string, string> = {}) {
  const r = spawnSync("node", [SCANNER, mode], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout + r.stderr };
}

// Built at runtime so this test file itself never contains a matching literal.
const fakeAwsKey = ["AKIA", "Z".repeat(16)].join("");

describe("secret-scan", () => {
  it("blocks an error-grade secret in staged lines without printing the value", () => {
    const dir = repoWith({ "a.ts": `const k = "${fakeAwsKey}";\n` });
    const r = scan(dir, "--staged");
    expect(r.code).toBe(1);
    expect(r.out).toContain("a.ts:1  aws-access-key");
    expect(r.out).not.toContain(fakeAwsKey);
  });

  it("scans an added line that starts with '++ ' (looks like a diff header) and keeps the file path", () => {
    const dir = repoWith({ "a.ts": `++ counter;\nconst k = "${fakeAwsKey}";\n` });
    const r = scan(dir, "--staged");
    expect(r.code).toBe(1);
    expect(r.out).toContain("a.ts:2  aws-access-key");
  });

  it("applies path checks to staged names with spaces or non-ASCII characters", () => {
    for (const name of ["my prod.env", "é.env"]) {
      const r = scan(repoWith({ [name]: "X=1\n" }), "--staged");
      expect(r.code, name).toBe(1);
      expect(r.out).toContain(`${name}:0  sensitive-path(*.env)`);
    }
  });

  it("reports content findings under the real path when the name has non-ASCII characters", () => {
    const r = scan(repoWith({ "설정 파일.ts": `const k = "${fakeAwsKey}";\n` }), "--staged");
    expect(r.code).toBe(1);
    expect(r.out).toContain("설정 파일.ts:1  aws-access-key");
  });

  it("blocks deny terms supplied via env, case-insensitively, without storing them in the repo", () => {
    const dir = repoWith({ "notes.md": "built for ACME-Widgets internal tool\n" });
    expect(scan(dir, "--staged").code).toBe(0);
    const r = scan(dir, "--staged", { DENY_TERMS: "acme-widgets" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("notes.md:1  deny-term");
    expect(r.out).not.toMatch(/acme/i);
  });

  it("masks a deny term inside a reported file name", () => {
    const r = scan(repoWith({ "acme-widgets-notes.md": "x\n" }), "--all", { DENY_TERMS: "Acme-Widgets" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("***-notes.md:0  deny-term(path)");
    expect(r.out).not.toMatch(/acme/i);
  });

  it("blocks sensitive paths and passes a clean tree", () => {
    expect(scan(repoWith({ "prod.env": "X=1\n" }), "--all").code).toBe(1);
    expect(scan(repoWith({ "ok.ts": "export const x = 1;\n" }), "--all").code).toBe(0);
  });

  it("reports suspect findings without blocking unless --strict", () => {
    const dir = repoWith({ "c.json": '{ "api_key": "abcdefgh12345" }\n' });
    expect(scan(dir, "--all").code).toBe(0);
    expect(spawnSync("node", [SCANNER, "--all", "--strict"], { cwd: dir }).status).toBe(1);
  });

  describe("shared allowlist (.gitleaks.toml)", () => {
    const toml = "[allowlist]\nregexes = [\n  '''demo-reader-key-NOT-A-SECRET''',\n]\n";

    it("silences a suspect finding whose matched value is allowlisted, and only that one", () => {
      const dir = repoWith({
        ".gitleaks.toml": toml,
        "c.json": `{ "api_key": "demo-reader-key-NOT-A-SECRET" }\n{ "api_key": "${["real", "Looking12345"].join("")}" }\n`,
      });
      const r = scan(dir, "--all");
      expect(r.out).not.toContain("c.json:1");
      expect(r.out).toContain("c.json:2  secret-like-quoted-key");
    });

    it("never silences an error-grade secret, even on a line with an allowlisted value", () => {
      const dir = repoWith({
        ".gitleaks.toml": toml,
        "a.ts": `const demo = "demo-reader-key-NOT-A-SECRET"; const k = "${fakeAwsKey}";\n`,
      });
      const r = scan(dir, "--all");
      expect(r.code).toBe(1);
      expect(r.out).toContain("a.ts:1  aws-access-key");
    });

    it("fails closed when an allowlist regex does not compile", () => {
      const dir = repoWith({ ".gitleaks.toml": "[allowlist]\nregexes = [\n  '''(unclosed''',\n]\n", "ok.ts": "x\n" });
      expect(scan(dir, "--all").code).toBe(2);
    });
  });

  describe("--history", () => {
    /** A repo whose deny term exists only in history: in a deleted file, an old path and a commit message. */
    function repoWithHistory() {
      const dir = mkdtempSync(join(tmpdir(), "scan-hist-"));
      const g = (...a: string[]) =>
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: dir });
      g("init", "-q");
      writeFileSync(join(dir, "notes.md"), "built for Acme-Widgets\n");
      writeFileSync(join(dir, "acme-widgets.txt"), "x\n");
      g("add", ".");
      g("commit", "-q", "-m", "first");
      rmSync(join(dir, "notes.md"));
      rmSync(join(dir, "acme-widgets.txt"));
      writeFileSync(join(dir, "clean.md"), "nothing here\n");
      g("add", "-A");
      g("commit", "-q", "-m", "second: remove the ACME-WIDGETS notes");
      return dir;
    }
    const env = { DENY_TERMS: "acme-widgets" };

    it("finds deny terms that only exist in history, which --all cannot see", () => {
      const dir = repoWithHistory();
      expect(scan(dir, "--all", env).code).toBe(0);
      const r = scan(dir, "--history", env);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/notes\.md \(blob [0-9a-f]{7}\) {2}deny-term/);
      expect(r.out).toMatch(/\(blob [0-9a-f]{7}\) {2}deny-term\(path\)/);
      expect(r.out).toMatch(/<commit message [0-9a-f]{7}> {2}deny-term/);
    });

    it("never prints the deny term, not even inside a file name", () => {
      const r = scan(repoWithHistory(), "--history", env);
      expect(r.out).toContain("***.txt");
      expect(r.out).not.toMatch(/acme/i);
    });

    it("passes a clean history and is a no-op without deny terms", () => {
      expect(scan(repoWithHistory(), "--history", { DENY_TERMS: "not-in-repo" }).code).toBe(0);
      const r = scan(repoWithHistory(), "--history", { DENY_TERMS: "" });
      expect(r.code).toBe(0);
      expect(r.out).toContain("0 deny terms, nothing to check");
    });
  });
});
