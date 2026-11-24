import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
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

  it("blocks deny terms supplied via env, case-insensitively, without storing them in the repo", () => {
    const dir = repoWith({ "notes.md": "built for ACME-Widgets internal tool\n" });
    expect(scan(dir, "--staged").code).toBe(0);
    const r = scan(dir, "--staged", { DENY_TERMS: "acme-widgets" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("notes.md:1  deny-term");
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
});
