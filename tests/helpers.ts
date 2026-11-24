import { sha256Hex } from "../src/canonical.js";
import { createApp } from "../src/app.js";
import { MemoryAuditSink, type AuditSink } from "../src/audit.js";
import type { KeyRecord, Scope } from "../src/auth.js";
import { OrderStore, seedOrders } from "../src/domain/orders.js";

export const SECRETS = {
  reader: "test-reader-secret-value",
  support: "test-support-secret-value",
  operator: "test-operator-secret-value",
  operator2: "test-operator2-secret-value",
} as const;

const SCOPES: Record<keyof typeof SECRETS, Scope[]> = {
  reader: ["orders:read"],
  support: ["orders:read", "orders:write:note"],
  operator: ["orders:read", "orders:write:status", "orders:write:cancel", "orders:write:note"],
  operator2: ["orders:read", "orders:write:status", "orders:write:cancel", "orders:write:note"],
};

export const KEYS: KeyRecord[] = (Object.keys(SECRETS) as (keyof typeof SECRETS)[]).map((id) => ({
  id,
  sha256: sha256Hex(SECRETS[id]),
  scopes: SCOPES[id],
}));

/** A clock the test moves by hand. */
export function fakeClock(start = "2026-03-01T09:00:00.000Z") {
  let t = Date.parse(start);
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

export const TTL_MS = 5 * 60 * 1000;

export function makeApp(opts: { audit?: AuditSink } = {}) {
  const clock = fakeClock();
  const audit = opts.audit ?? new MemoryAuditSink();
  const store = new OrderStore(seedOrders(), clock.now);
  let n = 0;
  const app = createApp({
    store,
    keys: KEYS,
    audit,
    planTtlMs: TTL_MS,
    now: clock.now,
    planIdFactory: () => `plan_test_${++n}`,
  });
  return { app, store, clock, audit };
}

/** Narrow a CallResult to its success branch or fail the test with the error. */
export function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}

export function err<T extends { ok: boolean }>(r: T): Extract<T, { ok: false }> {
  if (r.ok) throw new Error(`expected error, got ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: false }>;
}
