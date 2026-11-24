/** Error codes returned to the MCP client. Stable strings: tests and clients match on them. */
export type ToolErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "invalid_input"
  | "not_found"
  | "invalid_transition"
  | "plan_not_found"
  | "plan_already_used"
  | "plan_expired"
  | "plan_key_mismatch"
  | "hash_mismatch"
  | "stale_plan"
  | "internal";

export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}
