import { describe, expect, it } from "vitest";
import { authenticate, parseKeysFile } from "../src/auth.js";
import { KEYS, SECRETS, err, makeApp, ok } from "./helpers.js";

describe("least-privilege keys", () => {
  it("a read-only key can read", async () => {
    const { app } = makeApp();
    const r = ok(await app.callTool("list_orders", {}, SECRETS.reader));
    expect((r.data.orders as unknown[]).length).toBe(3);
  });

  it.each([
    ["preview_cancel_order", { order_id: "ord_1001", reason: "nope nope" }],
    ["preview_update_order_status", { order_id: "ord_1001", status: "paid" }],
    ["preview_add_order_note", { order_id: "ord_1001", note: "x" }],
  ])("a read-only key cannot call %s", async (tool, args) => {
    const { app } = makeApp();
    const r = err(await app.callTool(tool, args, SECRETS.reader));
    expect(r.error.code).toBe("forbidden");
    expect(app.plans.size).toBe(0);
  });

  it("a note-only key can add notes but not cancel", async () => {
    const { app } = makeApp();
    ok(await app.callTool("preview_add_order_note", { order_id: "ord_1001", note: "hi" }, SECRETS.support));
    const r = err(await app.callTool("preview_cancel_order", { order_id: "ord_1001", reason: "no!!" }, SECRETS.support));
    expect(r.error.code).toBe("forbidden");
  });

  it("a read-only key cannot execute, even with a valid plan id and hash", async () => {
    const { app, store } = makeApp();
    const p = ok(await app.callTool("preview_cancel_order", { order_id: "ord_1001", reason: "abc" }, SECRETS.operator));
    const r = err(
      await app.callTool("execute_plan", { plan_id: p.data.plan_id, content_hash: p.data.content_hash }, SECRETS.reader),
    );
    expect(r.error.code).toBe("forbidden");
    expect(store.get("ord_1001").status).toBe("pending");
  });

  it("a plan can only be executed by the key that previewed it", async () => {
    const { app, store } = makeApp();
    const p = ok(await app.callTool("preview_cancel_order", { order_id: "ord_1001", reason: "abc" }, SECRETS.operator));
    const r = err(
      await app.callTool("execute_plan", { plan_id: p.data.plan_id, content_hash: p.data.content_hash }, SECRETS.operator2),
    );
    expect(r.error.code).toBe("plan_key_mismatch");
    expect(store.get("ord_1001").status).toBe("pending");
  });

  it("an unknown or missing key is denied for every tool", async () => {
    const { app } = makeApp();
    expect(err(await app.callTool("list_orders", {}, "wrong")).error.code).toBe("unauthenticated");
    expect(err(await app.callTool("list_orders", {}, undefined)).error.code).toBe("unauthenticated");
  });

  it("scope is checked before input validation (no schema hints to unauthorised keys)", async () => {
    const { app } = makeApp();
    const r = err(await app.callTool("preview_cancel_order", { bogus: true }, SECRETS.reader));
    expect(r.error.code).toBe("forbidden");
  });

  it("authenticate maps a secret to its key id and scopes only", () => {
    const p = authenticate(SECRETS.support, KEYS);
    expect(p.keyId).toBe("support");
    expect([...p.scopes].sort()).toEqual(["orders:read", "orders:write:note"]);
  });

  it("rejects key files with unknown scopes, duplicate ids or shared secrets", () => {
    const k = { id: "a1", sha256: "a".repeat(64), scopes: ["orders:read"] };
    expect(() => parseKeysFile({ keys: [{ ...k, scopes: ["orders:*"] }] })).toThrow();
    expect(() => parseKeysFile({ keys: [k, { ...k, sha256: "b".repeat(64) }] })).toThrow(/duplicate/);
    expect(() => parseKeysFile({ keys: [k, { ...k, id: "a2" }] })).toThrow(/share/);
  });
});
