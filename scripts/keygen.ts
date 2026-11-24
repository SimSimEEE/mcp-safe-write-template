/**
 * Create an API key entry.
 *
 *   npm run keygen -- --id support-bot --scopes orders:read,orders:write:note
 *
 * Prints the secret ONCE (give it to the client config) and the JSON entry to
 * paste into config/keys.json. Only the sha256 is stored on the server side.
 */
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { SCOPES, type Scope } from "../src/auth.js";
import { sha256Hex } from "../src/canonical.js";

const { values } = parseArgs({
  options: {
    id: { type: "string" },
    scopes: { type: "string" },
    description: { type: "string" },
  },
});

if (!values.id || !values.scopes) {
  console.error(`usage: npm run keygen -- --id <id> --scopes <comma list>\nscopes: ${SCOPES.join(", ")}`);
  process.exit(2);
}
const scopes = values.scopes.split(",").map((s) => s.trim());
const unknown = scopes.filter((s) => !(SCOPES as readonly string[]).includes(s));
if (unknown.length) {
  console.error(`unknown scope(s): ${unknown.join(", ")}\nscopes: ${SCOPES.join(", ")}`);
  process.exit(2);
}

const secret = `msw_${randomBytes(32).toString("base64url")}`;
const entry = {
  id: values.id,
  ...(values.description ? { description: values.description } : {}),
  sha256: sha256Hex(secret),
  scopes: scopes as Scope[],
};
console.log("# secret (shown once; put it in the client's MCP_API_KEY):");
console.log(secret);
console.log("# entry for config/keys.json:");
console.log(JSON.stringify(entry, null, 2));
