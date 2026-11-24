import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../src/server.js";
import { SECRETS, makeApp } from "./helpers.js";

async function connect(secret: string) {
  const { app, store } = makeApp();
  const server = createMcpServer(app, secret);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(ct);
  return { client, store };
}

function payload(r: unknown): Record<string, unknown> {
  return (r as { structuredContent: Record<string, unknown> }).structuredContent;
}

describe("over the MCP protocol", () => {
  it("lists tools with schemas and safety annotations", async () => {
    const { client } = await connect(SECRETS.operator);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "list_orders",
      "get_order",
      "preview_update_order_status",
      "preview_cancel_order",
      "preview_add_order_note",
      "execute_plan",
    ]);
    const exec = tools.find((t) => t.name === "execute_plan")!;
    expect(exec.annotations?.destructiveHint).toBe(true);
    expect(exec.inputSchema.required).toEqual(["plan_id", "content_hash"]);
    expect(tools.find((t) => t.name === "preview_cancel_order")!.annotations?.readOnlyHint).toBe(true);
  });

  it("runs read -> preview -> execute end to end", async () => {
    const { client, store } = await connect(SECRETS.operator);
    const read = await client.callTool({ name: "get_order", arguments: { order_id: "ord_1002" } });
    expect(read.isError).toBe(false);
    const prev = await client.callTool({
      name: "preview_update_order_status",
      arguments: { order_id: "ord_1002", status: "shipped" },
    });
    const plan = payload(prev);
    const exec = await client.callTool({
      name: "execute_plan",
      arguments: { plan_id: plan.plan_id, content_hash: plan.content_hash },
    });
    expect(exec.isError).toBe(false);
    expect(store.get("ord_1002").status).toBe("shipped");
  });

  it("returns denials as tool errors, not protocol errors", async () => {
    const { client } = await connect(SECRETS.reader);
    const r = await client.callTool({
      name: "preview_cancel_order",
      arguments: { order_id: "ord_1001", reason: "x y z" },
    });
    expect(r.isError).toBe(true);
    expect(payload(r)).toMatchObject({ error: { code: "forbidden" } });
  });
});
