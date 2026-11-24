#!/usr/bin/env node
// Runs on `npm install` (prepare). Points git at the versioned hooks in .githooks/.
// Skipped in CI and outside a git checkout, so installing the package never fails because of it.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

if (process.env.CI || !existsSync(".git")) process.exit(0);
try {
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
  console.log("git hooks: core.hooksPath -> .githooks (pre-commit, commit-msg, pre-push)");
} catch {
  console.warn("git hooks: could not set core.hooksPath; run `git config core.hooksPath .githooks` manually");
}
