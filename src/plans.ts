import { randomUUID, timingSafeEqual } from "node:crypto";
import { canonicalJson, sha256Hex } from "./canonical.js";
import { ToolError } from "./errors.js";

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

/** What a preview produces before it is stored as a plan. */
export interface PlanDraft {
  /** Name of the write tool that produced this plan, e.g. "cancel_order". */
  action: string;
  /** The entity the plan will touch, and the version it was previewed against. */
  target: { type: string; id: string; version: number };
  /** Validated arguments the write will be executed with. */
  args: Record<string, unknown>;
  /** Human-readable diff. This is what the user confirms. */
  changes: FieldChange[];
  summary: string;
}

export interface Plan extends PlanDraft {
  id: string;
  keyId: string;
  createdAt: string;
  expiresAt: string;
  contentHash: string;
}

/** The fields that the content hash covers. Anything that changes the effect of the write is in here. */
export function hashPlanContent(p: Omit<Plan, "id" | "contentHash" | "createdAt">): string {
  return sha256Hex(
    canonicalJson({
      action: p.action,
      target: p.target,
      args: p.args,
      changes: p.changes,
      keyId: p.keyId,
      expiresAt: p.expiresAt,
    }),
  );
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export interface PlanStoreOptions {
  ttlMs: number;
  now?: () => Date;
  idFactory?: () => string;
}

/**
 * Holds previewed plans until they are executed or expire.
 *
 * Single process, in memory: a restart drops every pending plan, which is the
 * safe direction (the user previews again). If you run several server replicas,
 * move this into a shared store with an atomic "consume" operation.
 */
export class PlanStore {
  private readonly plans = new Map<string, Plan>();
  /** Ids that can no longer run, with why. Kept for a while to give a precise error on replay. */
  private readonly used = new Map<string, { at: number; reason: "executed" | "rejected" }>();
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(private readonly opts: PlanStoreOptions) {
    this.now = opts.now ?? (() => new Date());
    this.idFactory = opts.idFactory ?? (() => `plan_${randomUUID()}`);
  }

  create(draft: PlanDraft, keyId: string): Plan {
    this.prune();
    const created = this.now();
    const expiresAt = new Date(created.getTime() + this.opts.ttlMs).toISOString();
    const base = { ...draft, keyId, expiresAt };
    const plan: Plan = {
      ...base,
      id: this.idFactory(),
      createdAt: created.toISOString(),
      contentHash: hashPlanContent(base),
    };
    this.plans.set(plan.id, plan);
    return structuredClone(plan);
  }

  /**
   * Validate and remove a plan in one step. After this call the plan can never
   * be executed again, even if the write that follows fails.
   */
  consume(planId: string, contentHash: string, keyId: string): Plan {
    const plan = this.plans.get(planId);
    if (!plan) {
      const used = this.used.get(planId);
      if (used) {
        const what = used.reason === "executed" ? "was already executed" : "was rejected by an earlier execute";
        throw new ToolError("plan_already_used", `plan ${planId} ${what}; preview again`);
      }
      throw new ToolError("plan_not_found", `plan ${planId} does not exist or has expired`);
    }
    if (plan.keyId !== keyId) {
      // Do not reveal who owns the plan.
      throw new ToolError("plan_key_mismatch", `plan ${planId} was created by a different key`);
    }
    if (this.now().getTime() >= Date.parse(plan.expiresAt)) {
      this.plans.delete(planId);
      throw new ToolError("plan_expired", `plan ${planId} expired at ${plan.expiresAt}; preview again`);
    }
    // Recompute instead of trusting the stored hash: catches a plan mutated after preview.
    const expected = hashPlanContent(plan);
    if (!safeEqualHex(contentHash, expected) || !safeEqualHex(plan.contentHash, expected)) {
      // Fail closed: a mismatch burns the plan, so a client cannot keep guessing.
      this.burn(planId, "rejected");
      throw new ToolError(
        "hash_mismatch",
        `content_hash does not match plan ${planId}; the confirmed content differs from the preview`,
      );
    }
    this.burn(planId, "executed");
    return structuredClone(plan);
  }

  /** Look at a pending plan without consuming it (used to find the scope an execute needs). */
  peek(planId: string): Plan | undefined {
    const p = this.plans.get(planId);
    return p ? structuredClone(p) : undefined;
  }

  /** Visible for tests. */
  get size(): number {
    return this.plans.size;
  }

  private burn(planId: string, reason: "executed" | "rejected"): void {
    this.plans.delete(planId);
    this.used.set(planId, { at: this.now().getTime(), reason });
  }

  private prune(): void {
    const t = this.now().getTime();
    for (const [id, p] of this.plans) {
      if (t >= Date.parse(p.expiresAt)) this.plans.delete(id);
    }
    // Remember used ids for two TTLs so replays get a precise error, then forget.
    for (const [id, u] of this.used) {
      if (t - u.at > this.opts.ttlMs * 2) this.used.delete(id);
    }
  }
}
