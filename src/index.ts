#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createApp } from "./app.js";
import { authenticate, loadKeysFile } from "./auth.js";
import { JsonlAuditSink } from "./audit.js";
import { loadConfig } from "./config.js";
import { OrderStore, seedOrders } from "./domain/orders.js";
import { createMcpServer } from "./server.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const keys = loadKeysFile(cfg.keysFile);
  // Fail fast: a misconfigured key should stop the server, not produce a stream of denials.
  const principal = authenticate(cfg.apiKey, keys);

  const app = createApp({
    store: new OrderStore(seedOrders()),
    keys,
    audit: new JsonlAuditSink(cfg.auditFile),
    planTtlMs: cfg.planTtlMs,
  });
  const server = createMcpServer(app, cfg.apiKey);
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel; diagnostics go to stderr.
  console.error(
    `[mcp-safe-write] ready as key "${principal.keyId}" scopes=[${[...principal.scopes].join(",")}] audit=${cfg.auditFile}`,
  );
}

main().catch((e: unknown) => {
  console.error(`[mcp-safe-write] failed to start: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
