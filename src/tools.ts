import { z } from "zod";
import type { Scope } from "./auth.js";
import { DomainError, ORDER_STATUSES, OrderStore, canTransition, orderTotal, type Order } from "./domain/orders.js";
import { ToolError } from "./errors.js";
import type { FieldChange, Plan, PlanDraft } from "./plans.js";

export type ToolKind = "read" | "preview" | "execute";

export interface ToolContext {
  store: OrderStore;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  kind: ToolKind;
  /** Scope required to call the tool. `execute_plan` is checked against the plan's action instead. */
  scope: Scope | "per-plan";
  input: z.ZodObject;
  /** read: returns data. preview: returns a PlanDraft. execute is handled by the app. */
  run?: (ctx: ToolContext, args: Record<string, unknown>) => unknown;
}

/** A write the server knows how to execute from a stored plan. */
export interface WriteAction {
  scope: Scope;
  apply: (store: OrderStore, plan: Plan) => Order;
}

const orderId = z.string().regex(/^ord_[0-9]{1,12}$/, "order ids look like ord_1001");

function view(o: Order) {
  return { ...o, total: orderTotal(o) };
}

function domain<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof DomainError) throw new ToolError(e.code, e.message);
    throw e;
  }
}

// ---------------------------------------------------------------- read tools

const listOrders: ToolDef = {
  name: "list_orders",
  title: "List orders",
  description: "List orders, optionally filtered by status. Read-only.",
  kind: "read",
  scope: "orders:read",
  input: z.strictObject({
    status: z.enum(ORDER_STATUSES).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  run: ({ store }, a) => {
    const args = a as { status?: Order["status"]; limit?: number };
    return { orders: store.list(args).map(view) };
  },
};

const getOrder: ToolDef = {
  name: "get_order",
  title: "Get order",
  description: "Get one order by id, including its current version. Read-only.",
  kind: "read",
  scope: "orders:read",
  input: z.strictObject({ order_id: orderId }),
  run: ({ store }, a) => domain(() => ({ order: view(store.get(a.order_id as string)) })),
};

// ------------------------------------------------------------- preview tools

/** Note appended when a status change carries a reason. Shared by preview and executor so they cannot drift. */
function statusNote(from: Order["status"], to: Order["status"], reason: string): string {
  return `${from} -> ${to}: ${reason}`;
}

function changed(field: string, before: unknown, after: unknown): FieldChange {
  return { field, before, after };
}

const previewUpdateStatus: ToolDef = {
  name: "preview_update_order_status",
  title: "Preview: change order status",
  description:
    "Step 1 of 2. Computes what changing an order's status would do and returns a plan " +
    "(plan_id, content_hash, expires_at). Nothing is written. Show `changes` to the user; " +
    "only after they confirm, call execute_plan with the same plan_id and content_hash.",
  kind: "preview",
  scope: "orders:write:status",
  input: z.strictObject({
    order_id: orderId,
    status: z.enum(ORDER_STATUSES).exclude(["cancelled"]),
    reason: z.string().min(1).max(200).optional().describe("Optional; appended to the order notes"),
  }),
  run: ({ store }, a): PlanDraft =>
    domain(() => {
      const o = store.get(a.order_id as string);
      const to = a.status as Order["status"];
      if (!canTransition(o.status, to)) {
        throw new ToolError("invalid_transition", `cannot move ${o.id} from ${o.status} to ${to}`);
      }
      const reason = (a.reason as string | undefined) ?? null;
      const changes = [changed("status", o.status, to)];
      if (reason) changes.push(changed("notes", o.notes, [...o.notes, statusNote(o.status, to, reason)]));
      return {
        action: "update_order_status",
        target: { type: "order", id: o.id, version: o.version },
        args: { order_id: o.id, status: to, reason },
        changes,
        summary: `Order ${o.id} (${o.customer}): status ${o.status} -> ${to}`,
      };
    }),
};

const previewCancel: ToolDef = {
  name: "preview_cancel_order",
  title: "Preview: cancel order",
  description:
    "Step 1 of 2. Computes what cancelling an order would do and returns a plan. Nothing is written. " +
    "A reason is required and is appended to the order notes.",
  kind: "preview",
  scope: "orders:write:cancel",
  input: z.strictObject({ order_id: orderId, reason: z.string().min(3).max(200) }),
  run: ({ store }, a): PlanDraft =>
    domain(() => {
      const o = store.get(a.order_id as string);
      if (!canTransition(o.status, "cancelled")) {
        throw new ToolError("invalid_transition", `cannot cancel ${o.id} in status ${o.status}`);
      }
      const note = `cancelled: ${a.reason as string}`;
      return {
        action: "cancel_order",
        target: { type: "order", id: o.id, version: o.version },
        args: { order_id: o.id, reason: a.reason },
        changes: [changed("status", o.status, "cancelled"), changed("notes", o.notes, [...o.notes, note])],
        summary: `Cancel order ${o.id} (${o.customer}, total ${orderTotal(o)})`,
      };
    }),
};

const previewAddNote: ToolDef = {
  name: "preview_add_order_note",
  title: "Preview: add order note",
  description: "Step 1 of 2. Computes the result of appending a note to an order and returns a plan.",
  kind: "preview",
  scope: "orders:write:note",
  input: z.strictObject({ order_id: orderId, note: z.string().min(1).max(500) }),
  run: ({ store }, a): PlanDraft =>
    domain(() => {
      const o = store.get(a.order_id as string);
      return {
        action: "add_order_note",
        target: { type: "order", id: o.id, version: o.version },
        args: { order_id: o.id, note: a.note },
        changes: [changed("notes", o.notes, [...o.notes, a.note])],
        summary: `Add a note to order ${o.id}`,
      };
    }),
};

// ------------------------------------------------------------------- execute

const executePlan: ToolDef = {
  name: "execute_plan",
  title: "Execute a confirmed plan",
  description:
    "Step 2 of 2. Executes a plan returned by a preview_* tool. Requires the plan_id and the " +
    "content_hash from that preview. Fails if the plan expired, was already used, was created by " +
    "another key, the hash does not match, or the order changed since the preview. " +
    "Call this only after the user has confirmed the previewed changes.",
  kind: "execute",
  scope: "per-plan",
  input: z.strictObject({
    plan_id: z.string().min(1).max(100),
    content_hash: z.string().regex(/^[0-9a-f]{64}$/, "content_hash is 64 lowercase hex chars"),
  }),
};

export const TOOLS: readonly ToolDef[] = [
  listOrders,
  getOrder,
  previewUpdateStatus,
  previewCancel,
  previewAddNote,
  executePlan,
];

/**
 * Executors re-derive the write from the plan's validated args. The store
 * re-checks the version, so a plan previewed against an older order fails.
 */
export const WRITE_ACTIONS: Readonly<Record<string, WriteAction>> = {
  update_order_status: {
    scope: "orders:write:status",
    apply: (store, plan) => {
      const to = plan.args.status as Order["status"];
      const reason = plan.args.reason as string | null;
      return store.apply(plan.target.id, plan.target.version, (o) => {
        if (!canTransition(o.status, to)) throw new DomainError("invalid_transition", "transition no longer valid");
        if (reason) o.notes.push(statusNote(o.status, to, reason));
        o.status = to;
      });
    },
  },
  cancel_order: {
    scope: "orders:write:cancel",
    apply: (store, plan) =>
      store.apply(plan.target.id, plan.target.version, (o) => {
        o.status = "cancelled";
        o.notes.push(`cancelled: ${plan.args.reason as string}`);
      }),
  },
  add_order_note: {
    scope: "orders:write:note",
    apply: (store, plan) =>
      store.apply(plan.target.id, plan.target.version, (o) => {
        o.notes.push(plan.args.note as string);
      }),
  },
};

export { view as orderView };
