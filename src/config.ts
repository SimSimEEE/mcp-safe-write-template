import { resolve } from "node:path";

export interface RuntimeConfig {
  keysFile: string;
  auditFile: string;
  planTtlMs: number;
  apiKey: string | undefined;
}

/** All configuration comes from the environment so client configs stay declarative. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const ttlSec = Number(env.MCP_PLAN_TTL_SECONDS ?? "300");
  if (!Number.isFinite(ttlSec) || ttlSec < 10 || ttlSec > 3600) {
    throw new Error("MCP_PLAN_TTL_SECONDS must be between 10 and 3600");
  }
  return {
    keysFile: resolve(env.MCP_KEYS_FILE ?? "config/keys.json"),
    auditFile: resolve(env.MCP_AUDIT_FILE ?? "audit/audit.jsonl"),
    planTtlMs: ttlSec * 1000,
    apiKey: env.MCP_API_KEY,
  };
}
