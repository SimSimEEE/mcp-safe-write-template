import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { sha256Hex } from "./canonical.js";
import { ToolError } from "./errors.js";

/**
 * Scopes are explicit strings. There are no wildcards on purpose: a key gets
 * exactly the capabilities listed for it, and adding a new write tool never
 * silently widens an existing key.
 */
export const SCOPES = [
  "orders:read",
  "orders:write:status",
  "orders:write:cancel",
  "orders:write:note",
] as const;
export type Scope = (typeof SCOPES)[number];

const keyRecordSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/, "id: lowercase letters, digits, _ and -"),
  description: z.string().optional(),
  /** sha256 of the secret, hex. The secret itself is never stored on the server. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "sha256: 64 lowercase hex chars"),
  scopes: z.array(z.enum(SCOPES)).min(1),
});
const keysFileSchema = z.object({ keys: z.array(keyRecordSchema).min(1) });

export type KeyRecord = z.infer<typeof keyRecordSchema>;

/** The identity a request runs as. Contains no secret material. */
export interface Principal {
  keyId: string;
  scopes: ReadonlySet<Scope>;
}

export function parseKeysFile(json: unknown): KeyRecord[] {
  const parsed = keysFileSchema.parse(json);
  const ids = new Set<string>();
  const hashes = new Set<string>();
  for (const k of parsed.keys) {
    if (ids.has(k.id)) throw new Error(`duplicate key id: ${k.id}`);
    if (hashes.has(k.sha256)) throw new Error(`two key ids share one secret: ${k.id}`);
    ids.add(k.id);
    hashes.add(k.sha256);
  }
  return parsed.keys;
}

export function loadKeysFile(path: string): KeyRecord[] {
  return parseKeysFile(JSON.parse(readFileSync(path, "utf8")));
}

/** Resolve a raw secret to a principal. Compares hashes in constant time. */
export function authenticate(secret: string | undefined, keys: readonly KeyRecord[]): Principal {
  if (!secret) throw new ToolError("unauthenticated", "no API key configured for this server process");
  const digest = Buffer.from(sha256Hex(secret), "utf8");
  let match: KeyRecord | undefined;
  for (const k of keys) {
    const candidate = Buffer.from(k.sha256, "utf8");
    // Do not break early: every comparison runs, so timing does not reveal the position.
    if (candidate.length === digest.length && timingSafeEqual(candidate, digest)) match = k;
  }
  if (!match) throw new ToolError("unauthenticated", "API key is not recognised");
  return { keyId: match.id, scopes: new Set(match.scopes) };
}

export function requireScope(principal: Principal, scope: Scope, tool: string): void {
  if (!principal.scopes.has(scope)) {
    throw new ToolError("forbidden", `key "${principal.keyId}" lacks scope "${scope}" required by ${tool}`);
  }
}
