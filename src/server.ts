import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { App } from "./app.js";

export const SERVER_NAME = "mcp-safe-write-template";
export const SERVER_VERSION = "0.1.0";

/**
 * Wraps the app in an MCP server. Uses the low-level Server so that every call,
 * including ones with invalid arguments, reaches `app.callTool` and is audited.
 */
export function createMcpServer(app: App, secret: string | undefined): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Writes are two-step. Call a preview_* tool, show the returned summary and changes to the user, " +
        "and call execute_plan with the returned plan_id and content_hash only after the user confirms.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: app.tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: z.toJSONSchema(t.input, { target: "draft-7" }) as { type: "object" },
      annotations: {
        title: t.title,
        readOnlyHint: t.kind !== "execute",
        destructiveHint: t.kind === "execute",
        idempotentHint: t.kind !== "execute",
        openWorldHint: false,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const r = await app.callTool(req.params.name, req.params.arguments ?? {}, secret);
    const payload = r.ok ? r.data : { error: r.error };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
      isError: !r.ok,
    };
  });

  return server;
}
