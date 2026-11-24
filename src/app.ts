import { z } from "zod";
import { authenticate, requireScope, type KeyRecord, type Principal } from "./auth.js";
import type { AuditOutcome, AuditSink } from "./audit.js";
import { DomainError, OrderStore, StaleError } from "./domain/orders.js";
import { ToolError, type ToolErrorCode } from "./errors.js";
import { PlanStore, type PlanDraft } from "./plans.js";
import { TOOLS, WRITE_ACTIONS, orderView, type ToolDef } from "./tools.js";

export interface AppOptions {
  store: OrderStore;
  keys: readonly KeyRecord[];
  audit: AuditSink;
  /** How long a previewed plan stays executable. */
  planTtlMs: number;
  now?: () => Date;
  planIdFactory?: () => string;
}

export type CallResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: { code: ToolErrorCode; message: string } };

/**
 * Transport-independent core. Every tool call goes through `callTool`, which
 * always: authenticates, checks scope, validates input, runs, and writes one
 * audit line — including for calls that are denied or fail validation.
 */
export function createApp(opts: AppOptions) {
  const now = opts.now ?? (() => new Date());
  const plans = new PlanStore({ ttlMs: opts.planTtlMs, now, idFactory: opts.planIdFactory });
  const byName = new Map(TOOLS.map((t) => [t.name, t]));

  async function callTool(name: string, rawArgs: unknown, secret: string | undefined): Promise<CallResult> {
    const started = now().getTime();
    let principal: Principal | undefined;
    let planId: string | undefined;
    let contentHash: string | undefined;
    let outcome: AuditOutcome = "ok";
    let code: ToolErrorCode | undefined;
    let executed = false;
    let result: CallResult;
    try {
      result = await run();
    } catch (e) {
      const err = toToolError(e);
      code = err.code;
      outcome = err.code === "unauthenticated" || err.code === "forbidden" ? "denied" : "error";
      result = { ok: false, error: { code: err.code, message: err.message } };
    }

    try {
      opts.audit.write({
        ts: new Date(started).toISOString(),
        keyId: principal?.keyId ?? "anonymous",
        tool: name,
        args: rawArgs ?? {},
        outcome,
        ...(code ? { code } : {}),
        ...(planId ? { planId } : {}),
        ...(contentHash ? { contentHash } : {}),
        durationMs: now().getTime() - started,
      });
    } catch (e) {
      // No audit line means the call is not served (fail closed) — except a write that already
      // happened: it cannot be undone here, so say so plainly and the client must not retry it.
      console.error("[mcp-safe-write] audit write failed:", e);
      if (executed && result.ok) {
        return {
          ok: true,
          data: { ...result.data, audit_failed: true, warning: "write committed, but the audit line could not be written" },
        };
      }
      return { ok: false, error: { code: "internal", message: "audit log unavailable; the call was not served" } };
    }
    return result;

    async function run(): Promise<CallResult> {
      principal = authenticate(secret, opts.keys);
      const tool = byName.get(name);
      if (!tool) throw new ToolError("not_found", `unknown tool: ${name}`);
      // Scope before validation: a key without access learns nothing about the input contract.
      if (tool.scope !== "per-plan") requireScope(principal, tool.scope, tool.name);
      const args = parseArgs(tool, rawArgs);

      if (tool.kind === "read") {
        return { ok: true, data: tool.run!({ store: opts.store }, args) as Record<string, unknown> };
      }

      if (tool.kind === "preview") {
        const draft = tool.run!({ store: opts.store }, args) as PlanDraft;
        const plan = plans.create(draft, principal.keyId);
        planId = plan.id;
        contentHash = plan.contentHash;
        return {
          ok: true,
          data: {
            plan_id: plan.id,
            content_hash: plan.contentHash,
            expires_at: plan.expiresAt,
            action: plan.action,
            target: plan.target,
            summary: plan.summary,
            changes: plan.changes,
            next_step:
              "Show `summary` and `changes` to the user. If they confirm, call execute_plan " +
              "with this plan_id and content_hash before expires_at. If not, do nothing.",
          },
        };
      }

      // execute_plan
      planId = args.plan_id as string;
      contentHash = args.content_hash as string;
      const pending = plans.peek(planId);
      if (pending) {
        const action = WRITE_ACTIONS[pending.action];
        if (!action) throw new ToolError("internal", `no executor for action ${pending.action}`);
        requireScope(principal, action.scope, `execute_plan(${pending.action})`);
      } else if (![...principal.scopes].some((s) => s.startsWith("orders:write:"))) {
        throw new ToolError("forbidden", `key "${principal.keyId}" has no write scope`);
      }
      const plan = plans.consume(planId, contentHash, principal.keyId);
      const action = WRITE_ACTIONS[plan.action]!;
      const updated = action.apply(opts.store, plan);
      executed = true;
      return {
        ok: true,
        data: { executed: true, plan_id: plan.id, action: plan.action, order: orderView(updated) },
      };
    }
  }

  return { tools: TOOLS, callTool, plans };
}

function parseArgs(tool: ToolDef, raw: unknown): Record<string, unknown> {
  const r = tool.input.safeParse(raw ?? {});
  if (!r.success) {
    throw new ToolError("invalid_input", z.prettifyError(r.error));
  }
  return r.data as Record<string, unknown>;
}

function toToolError(e: unknown): ToolError {
  if (e instanceof ToolError) return e;
  if (e instanceof StaleError) return new ToolError("stale_plan", e.message);
  if (e instanceof DomainError) return new ToolError(e.code, e.message);
  // Never leak internals (stack, paths) to the client. Log them locally instead.
  console.error("[mcp-safe-write] unexpected error:", e);
  return new ToolError("internal", "internal error; see server logs");
}

export type App = ReturnType<typeof createApp>;
