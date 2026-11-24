import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlAuditSink, MemoryAuditSink, redact, type AuditEntry, type AuditSink } from "../src/audit.js";
import { SECRETS, makeApp, ok } from "./helpers.js";

function readJsonl(path: string): AuditEntry[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as AuditEntry);
}

describe("audit log", () => {
  it("writes one JSONL line per call with who, when, tool, args and outcome", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "audit-")), "a.jsonl");
    const { app } = makeApp({ audit: new JsonlAuditSink(path) });
    ok(await app.callTool("get_order", { order_id: "ord_1001" }, SECRETS.reader));
    const p = ok(await app.callTool("preview_cancel_order", { order_id: "ord_1001", reason: "dup" }, SECRETS.operator));
    ok(await app.callTool("execute_plan", { plan_id: p.data.plan_id, content_hash: p.data.content_hash }, SECRETS.operator));
    await app.callTool("preview_cancel_order", { order_id: "ord_1002", reason: "nope" }, SECRETS.reader);

    const lines = readJsonl(path);
    expect(lines).toHaveLength(4);
    expect(lines.map((l) => [l.keyId, l.tool, l.outcome])).toEqual([
      ["reader", "get_order", "ok"],
      ["operator", "preview_cancel_order", "ok"],
      ["operator", "execute_plan", "ok"],
      ["reader", "preview_cancel_order", "denied"],
    ]);
    expect(lines[0]!.ts).toBe("2026-03-01T09:00:00.000Z");
    expect(lines[0]!.args).toEqual({ order_id: "ord_1001" });
    // Preview and execute are linked by plan id and hash, so a reviewer can pair them.
    expect(lines[1]!.planId).toBe(p.data.plan_id);
    expect(lines[2]!.planId).toBe(p.data.plan_id);
    expect(lines[2]!.contentHash).toBe(p.data.content_hash);
    expect(lines[3]!.code).toBe("forbidden");
  });

  it("records failed authentication as anonymous/denied", async () => {
    const audit = new MemoryAuditSink();
    const { app } = makeApp({ audit });
    await app.callTool("list_orders", {}, "not-a-key");
    expect(audit.entries[0]).toMatchObject({ keyId: "anonymous", outcome: "denied", code: "unauthenticated" });
  });

  it("records invalid input and domain errors as error outcomes", async () => {
    const audit = new MemoryAuditSink();
    const { app } = makeApp({ audit });
    await app.callTool("get_order", { order_id: "DROP TABLE" }, SECRETS.reader);
    await app.callTool("get_order", { order_id: "ord_9999" }, SECRETS.reader);
    expect(audit.entries.map((e) => [e.outcome, e.code])).toEqual([
      ["error", "invalid_input"],
      ["error", "not_found"],
    ]);
  });

  it("never writes the API key, and redacts secret-looking argument fields", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "audit-")), "a.jsonl");
    const { app } = makeApp({ audit: new JsonlAuditSink(path) });
    // Values are built at runtime so the repo's own secret scanners do not flag this fixture.
    const leak = (n: number) => ["leak", "me", String(n)].join("-");
    await app.callTool(
      "list_orders",
      { apiKey: leak(1), nested: { password: leak(2), Authorization: leak(3) } },
      SECRETS.operator,
    );
    await app.callTool("list_orders", {}, "a-wrong-key-that-must-not-be-logged");
    const raw = readFileSync(path, "utf8");
    for (const s of [SECRETS.operator, "a-wrong-key-that-must-not-be-logged", "leak-me-1", "leak-me-2", "leak-me-3"]) {
      expect(raw).not.toContain(s);
    }
    const R = "[REDACTED]";
    expect(readJsonl(path)[0]!.args).toEqual({ apiKey: R, nested: { password: R, Authorization: R } });
  });

  it("redact truncates long strings and deep nesting", () => {
    expect(redact("x".repeat(600))).toMatch(/…\[\+100 chars\]$/);
    let deep: unknown = "bottom";
    for (let i = 0; i < 12; i++) deep = { d: deep };
    expect(JSON.stringify(redact(deep))).toContain("[TRUNCATED]");
  });

  describe("when the audit sink fails", () => {
    const broken: AuditSink = {
      write: () => {
        throw new Error("disk full");
      },
    };

    it("does not serve reads or previews (fail closed)", async () => {
      const { app } = makeApp({ audit: broken });
      const r = await app.callTool("get_order", { order_id: "ord_1001" }, SECRETS.reader);
      expect(r).toMatchObject({ ok: false, error: { code: "internal" } });
    });

    it("reports a committed write as committed, so the client does not retry it", async () => {
      const audit = new MemoryAuditSink();
      let fail = false;
      const flaky: AuditSink = {
        write: (e) => {
          if (fail) throw new Error("disk full");
          audit.write(e);
        },
      };
      const { app, store } = makeApp({ audit: flaky });
      const p = ok(await app.callTool("preview_add_order_note", { order_id: "ord_1001", note: "n1" }, SECRETS.operator));
      fail = true;
      const r = ok(
        await app.callTool("execute_plan", { plan_id: p.data.plan_id, content_hash: p.data.content_hash }, SECRETS.operator),
      );
      expect(r.data).toMatchObject({ executed: true, audit_failed: true });
      expect(store.get("ord_1001").notes).toEqual(["n1"]);
    });
  });
});
