import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type AuditOutcome = "ok" | "denied" | "error";

export interface AuditEntry {
  ts: string;
  /** Key id (never the secret). "anonymous" when authentication failed. */
  keyId: string;
  tool: string;
  args: unknown;
  outcome: AuditOutcome;
  /** Error code for denied/error outcomes. */
  code?: string;
  planId?: string;
  contentHash?: string;
  durationMs: number;
}

const SECRET_KEY_PATTERN =
  /(pass(word|wd)?|secret|token|api[-_]?key|authorization|auth|credential|private[-_]?key|cookie|session)/i;
const MAX_STRING = 500;

/**
 * Remove secret-looking values before anything is written.
 *
 * Redaction is by field name, because a value-based check cannot tell a token
 * from an order id. Keep your tool argument names honest (`apiKey`, not `k`).
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[+${value.length - MAX_STRING} chars]` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? "[REDACTED]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface AuditSink {
  write(entry: AuditEntry): void;
}

/** Append-only JSONL file. One line per tool call, written synchronously before the response returns. */
export class JsonlAuditSink implements AuditSink {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  write(entry: AuditEntry): void {
    appendFileSync(this.path, `${JSON.stringify({ ...entry, args: redact(entry.args) })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}

/** For tests and for embedding: keeps entries in memory (still redacted). */
export class MemoryAuditSink implements AuditSink {
  readonly entries: AuditEntry[] = [];
  write(entry: AuditEntry): void {
    this.entries.push({ ...entry, args: redact(entry.args) });
  }
}
