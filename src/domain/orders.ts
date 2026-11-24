/**
 * A fictional order-management domain used as the example backend.
 *
 * Replace this module with a client for your real system. The rest of the
 * template (plans, scopes, audit) does not depend on what an "order" is: it only
 * needs (1) read functions, (2) a pure "what would change" function per write,
 * and (3) an apply function that re-checks the precondition.
 */

export const ORDER_STATUSES = ["pending", "paid", "shipped", "delivered", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface OrderItem {
  sku: string;
  qty: number;
  unitPrice: number;
}

export interface Order {
  id: string;
  customer: string;
  items: OrderItem[];
  status: OrderStatus;
  notes: string[];
  /** Incremented on every write. Plans are bound to the version they previewed. */
  version: number;
  updatedAt: string;
}

/** Allowed status transitions. Anything not listed is rejected at preview time. */
const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ["paid", "cancelled"],
  paid: ["shipped", "cancelled"],
  shipped: ["delivered"],
  delivered: [],
  cancelled: [],
};

export class DomainError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_transition" | "invalid_input",
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function orderTotal(order: Pick<Order, "items">): number {
  return order.items.reduce((sum, i) => sum + i.qty * i.unitPrice, 0);
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** In-memory store. Swap for a real API/DB client in your own project. */
export class OrderStore {
  private readonly orders = new Map<string, Order>();

  constructor(
    seed: Order[] = [],
    private readonly now: () => Date = () => new Date(),
  ) {
    for (const o of seed) this.orders.set(o.id, structuredClone(o));
  }

  list(filter: { status?: OrderStatus; limit?: number } = {}): Order[] {
    let all = [...this.orders.values()];
    if (filter.status) all = all.filter((o) => o.status === filter.status);
    all.sort((a, b) => a.id.localeCompare(b.id));
    return structuredClone(all.slice(0, filter.limit ?? 50));
  }

  get(id: string): Order {
    const o = this.orders.get(id);
    if (!o) throw new DomainError("not_found", `order ${id} not found`);
    return structuredClone(o);
  }

  /**
   * Apply a change computed earlier. `expectedVersion` is the version the plan
   * was previewed against; if someone else wrote in between, we refuse.
   */
  apply(id: string, expectedVersion: number, change: (o: Order) => void): Order {
    const current = this.orders.get(id);
    if (!current) throw new DomainError("not_found", `order ${id} not found`);
    if (current.version !== expectedVersion) {
      throw new StaleError(id, expectedVersion, current.version);
    }
    const next = structuredClone(current);
    change(next);
    next.version = current.version + 1;
    next.updatedAt = this.now().toISOString();
    this.orders.set(id, next);
    return structuredClone(next);
  }
}

export class StaleError extends Error {
  constructor(
    readonly orderId: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`order ${orderId} changed since preview (version ${expected} -> ${actual}); preview again`);
    this.name = "StaleError";
  }
}

/** Fictional seed data. No real customers, products or companies. */
export function seedOrders(): Order[] {
  const t = "2026-01-01T00:00:00.000Z";
  return [
    {
      id: "ord_1001",
      customer: "Customer A",
      items: [{ sku: "SKU-RED-MUG", qty: 2, unitPrice: 12000 }],
      status: "pending",
      notes: [],
      version: 1,
      updatedAt: t,
    },
    {
      id: "ord_1002",
      customer: "Customer B",
      items: [
        { sku: "SKU-BLUE-CAP", qty: 1, unitPrice: 25000 },
        { sku: "SKU-STICKER", qty: 5, unitPrice: 1000 },
      ],
      status: "paid",
      notes: ["gift wrap requested"],
      version: 3,
      updatedAt: t,
    },
    {
      id: "ord_1003",
      customer: "Customer C",
      items: [{ sku: "SKU-NOTEBOOK", qty: 3, unitPrice: 8000 }],
      status: "shipped",
      notes: [],
      version: 4,
      updatedAt: t,
    },
  ];
}
