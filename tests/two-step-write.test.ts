import { describe, expect, it } from "vitest";
import { SECRETS, err, makeApp, ok } from "./helpers.js";

const op = SECRETS.operator;

describe("preview -> confirm -> execute", () => {
  it("preview does not write anything", async () => {
    const { app, store } = makeApp();
    const before = store.get("ord_1001");
    const r = ok(await app.callTool("preview_cancel_order", { order_id: "ord_1001", reason: "customer asked" }, op));
    expect(r.data.plan_id).toBe("plan_test_1");
    expect(r.data.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.data.expires_at).toBe("2026-03-01T09:05:00.000Z");
    expect(r.data.changes).toEqual([
      { field: "status", before: "pending", after: "cancelled" },
      { field: "notes", before: [], after: ["cancelled: customer asked"] },
    ]);
    expect(store.get("ord_1001")).toEqual(before);
  });

  it("execute with the previewed id and hash applies exactly the previewed changes", async () => {
    const { app, store } = makeApp();
    const p = ok(await app.callTool("preview_cancel_order", { order_id: "ord_1001", reason: "customer asked" }, op));
    const x = ok(
      await app.callTool("execute_plan", { plan_id: p.data.plan_id, content_hash: p.data.content_hash }, op),
    );
    expect(x.data.executed).toBe(true);
    const after = store.get("ord_1001");
    for (const c of p.data.changes as { field: "status" | "notes"; after: unknown }[]) {
      expect(after[c.field]).toEqual(c.after);
    }
    expect(after.version).toBe(2);
  });

  it("a plan runs at most once", async () => {
    const { app, store } = makeApp();
    const p = ok(await app.callTool("preview_add_order_note", { order_id: "ord_1002", note: "called customer" }, op));
    const args = { plan_id: p.data.plan_id, content_hash: p.data.content_hash };
    ok(await app.callTool("execute_plan", args, op));
    const again = err(await app.callTool("execute_plan", args, op));
    expect(again.error.code).toBe("plan_already_used");
    expect(store.get("ord_1002").notes.filter((n) => n === "called customer")).toHaveLength(1);
  });

  it("refuses when the order changed after the preview (stale plan)", async () => {
    const { app, store } = makeApp();
    const p1 = ok(await app.callTool("preview_update_order_status", { order_id: "ord_1002", status: "shipped" }, op));
    const p2 = ok(await app.callTool("preview_add_order_note", { order_id: "ord_1002", note: "fragile" }, op));
    ok(await app.callTool("execute_plan", { plan_id: p2.data.plan_id, content_hash: p2.data.content_hash }, op));
    const stale = err(
      await app.callTool("execute_plan", { plan_id: p1.data.plan_id, content_hash: p1.data.content_hash }, op),
    );
    expect(stale.error.code).toBe("stale_plan");
    expect(store.get("ord_1002").status).toBe("paid");
  });

  it("rejects an invalid transition at preview time, before any plan exists", async () => {
    const { app } = makeApp();
    const r = err(await app.callTool("preview_update_order_status", { order_id: "ord_1003", status: "paid" }, op));
    expect(r.error.code).toBe("invalid_transition");
    expect(app.plans.size).toBe(0);
  });

  it("rejects unknown plan ids", async () => {
    const { app } = makeApp();
    const r = err(await app.callTool("execute_plan", { plan_id: "plan_nope", content_hash: "a".repeat(64) }, op));
    expect(r.error.code).toBe("plan_not_found");
  });
});

describe("expiry", () => {
  it("executes just before expiry", async () => {
    const { app, clock } = makeApp();
    const p = ok(await app.callTool("preview_add_order_note", { order_id: "ord_1001", note: "n" }, op));
    clock.advance(5 * 60 * 1000 - 1);
    ok(await app.callTool("execute_plan", { plan_id: p.data.plan_id, content_hash: p.data.content_hash }, op));
  });

  it("refuses at and after expires_at, and does not write", async () => {
    const { app, clock, store } = makeApp();
    const p = ok(await app.callTool("preview_cancel_order", { order_id: "ord_1001", reason: "too late" }, op));
    clock.advance(5 * 60 * 1000);
    const r = err(
      await app.callTool("execute_plan", { plan_id: p.data.plan_id, content_hash: p.data.content_hash }, op),
    );
    expect(r.error.code).toBe("plan_expired");
    expect(store.get("ord_1001").status).toBe("pending");
  });
});

describe("content hash", () => {
  it("refuses a hash that does not match the plan and burns the plan", async () => {
    const { app, store } = makeApp();
    const p = ok(await app.callTool("preview_cancel_order", { order_id: "ord_1001", reason: "dup order" }, op));
    const good = p.data.content_hash as string;
    const bad = (good[0] === "0" ? "1" : "0") + good.slice(1);
    const r = err(await app.callTool("execute_plan", { plan_id: p.data.plan_id, content_hash: bad }, op));
    expect(r.error.code).toBe("hash_mismatch");
    expect(store.get("ord_1001").status).toBe("pending");
    // Fail closed: the right hash no longer works either.
    const retry = err(await app.callTool("execute_plan", { plan_id: p.data.plan_id, content_hash: good }, op));
    expect(retry.error.code).toBe("plan_already_used");
  });

  it("uses another plan's hash -> mismatch (hashes are bound to content)", async () => {
    const { app } = makeApp();
    const a = ok(await app.callTool("preview_add_order_note", { order_id: "ord_1001", note: "A" }, op));
    const b = ok(await app.callTool("preview_add_order_note", { order_id: "ord_1001", note: "B" }, op));
    expect(a.data.content_hash).not.toBe(b.data.content_hash);
    const r = err(await app.callTool("execute_plan", { plan_id: a.data.plan_id, content_hash: b.data.content_hash }, op));
    expect(r.error.code).toBe("hash_mismatch");
  });

  it("detects a plan mutated in the store after preview", async () => {
    const { app } = makeApp();
    const p = ok(await app.callTool("preview_add_order_note", { order_id: "ord_1001", note: "harmless" }, op));
    // Simulate tampering with server-side state between preview and execute.
    const internal = (app.plans as unknown as { plans: Map<string, { args: Record<string, unknown> }> }).plans;
    internal.get(p.data.plan_id as string)!.args.note = "something else";
    const r = err(await app.callTool("execute_plan", { plan_id: p.data.plan_id, content_hash: p.data.content_hash }, op));
    expect(r.error.code).toBe("hash_mismatch");
  });

  it("rejects a malformed hash as invalid input", async () => {
    const { app } = makeApp();
    const r = err(await app.callTool("execute_plan", { plan_id: "plan_test_1", content_hash: "xyz" }, op));
    expect(r.error.code).toBe("invalid_input");
  });
});

describe("status change with a reason", () => {
  it("shows the note in the preview and writes exactly that note", async () => {
    const { app, store } = makeApp();
    const p = ok(
      await app.callTool("preview_update_order_status", { order_id: "ord_1002", status: "shipped", reason: "courier" }, op),
    );
    expect(p.data.changes).toEqual([
      { field: "status", before: "paid", after: "shipped" },
      { field: "notes", before: ["gift wrap requested"], after: ["gift wrap requested", "paid -> shipped: courier"] },
    ]);
    ok(await app.callTool("execute_plan", { plan_id: p.data.plan_id, content_hash: p.data.content_hash }, op));
    expect(store.get("ord_1002").notes).toEqual(["gift wrap requested", "paid -> shipped: courier"]);
  });
});
