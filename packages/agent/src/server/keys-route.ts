import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { issueToken, mcpEnabled } from "../mcp/tokens.js";
import { countKeyIssue, MCP_LIMITS } from "../mcp/usage.js";
import { visitorKey } from "../net/visitor-key.js";
import { reserve } from "../store/meter.js";
import type { AppDeps } from "./app.js";
import { clientAddressFrom, isAllowedPost } from "./guards.js";
import { TURNSTILE_ACTIONS } from "./turnstile.js";

const ROUTE = "/agent-keys";
const MAX_BODY_BYTES = 4 * 1024;
const MAX_TOKEN_LENGTH = 2_048;
/** The global daily cap on agent keys, set by the budget policy like every other bucket (D1.5). */
export const KEYS_BUCKET = "mcp:keys:day";

// Only the human check's answer may arrive. Any other field fails (C8.1).
const keyBody = z.strictObject({ turnstileToken: z.string().min(1).max(MAX_TOKEN_LENGTH) });

// Thrown inside the issue transaction so a refusal at a later step undoes the
// counts taken at an earlier one.
class IssueRefused extends Error {
  readonly code: "VISITOR_LIMIT" | "KEY_BUDGET";

  constructor(code: "VISITOR_LIMIT" | "KEY_BUDGET") {
    super(code);
    this.code = code;
  }
}

/**
 * Builds POST /agent-keys, which app.ts mounts. A website visitor who passes
 * the human check gets one agent key (F9). The checks run in this order, and
 * each refusal answers { error: CODE }, changes nothing, and writes one warn
 * line holding only the route and the code:
 * - C5.5: Origin equal to the app origin and Content-Type application/json,
 *   else 403 FORBIDDEN_ORIGIN;
 * - a body of at most 4 KiB, else 413 TOO_LARGE, holding exactly
 *   { turnstileToken }, else 400 BAD_INPUT;
 * - the mcp_enabled flag, else 503 MCP_OFF, which is also the answer when the
 *   flag cannot be read (C5.7);
 * - the client address from the edge header and its visitorKey, as for runs
 *   (C5.3), else 400 NO_CLIENT_ADDRESS;
 * - the human check for the agent-key action, so an answer solved for run
 *   start, for another hostname, or not at all is refused (D1.5, C5.9), else
 *   403 HUMAN_CHECK_FAILED;
 * - in one transaction: the visitor's daily count (3 a day), else 429
 *   VISITOR_LIMIT; the global mcp:keys:day bucket, else 429 KEY_BUDGET; then
 *   issueToken. A refusal rolls the whole transaction back, so a full global
 *   bucket does not use up the visitor's count.
 * Success is 201 { token, expiresAt } with Cache-Control no-store. The key
 * appears in that one response and nowhere else, never in a log (D1.4). A
 * database failure throws, and the app's error handler answers 500 INTERNAL
 * and logs only the route and a code.
 */
export function createAgentKeysRoute(deps: AppDeps): Hono {
  const { db, config } = deps;
  const now = deps.now ?? (() => new Date());
  const route = new Hono();

  // One line per refusal for the operator: this route and the code only,
  // never a header, a body, an address or a key (C3.6, D1.4).
  const refuse = (c: Context, status: ContentfulStatusCode, code: string): Response => {
    console.warn(JSON.stringify({ level: "warn", route: ROUTE, code }));
    return c.json({ error: code }, status);
  };

  const socketOf = (c: Context): string | null => {
    try {
      return deps.socketAddress(c);
    } catch {
      return null;
    }
  };

  const isHuman = async (token: string, address: string): Promise<boolean> => {
    try {
      return (await deps.verifyTurnstile(token, address, TURNSTILE_ACTIONS.agentKey)) === true;
    } catch {
      return false;
    }
  };

  const sameSiteJson: MiddlewareHandler = async (c, next) => {
    const allowed = isAllowedPost(
      { origin: c.req.header("origin") ?? null, contentType: c.req.header("content-type") ?? null },
      config.appOrigin,
    );
    if (!allowed) return refuse(c, 403, "FORBIDDEN_ORIGIN");
    await next();
  };
  const smallBody = bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => refuse(c, 413, "TOO_LARGE") });

  route.post(ROUTE, sameSiteJson, smallBody, async (c) => {
    let value: unknown;
    try {
      value = JSON.parse(await c.req.text());
    } catch {
      return refuse(c, 400, "BAD_INPUT");
    }
    const body = keyBody.safeParse(value);
    if (!body.success) return refuse(c, 400, "BAD_INPUT");
    if (!(await mcpEnabled(db))) return refuse(c, 503, "MCP_OFF");

    const headerValue = config.clientIpHeader === null ? null : (c.req.header(config.clientIpHeader) ?? null);
    const address = clientAddressFrom(headerValue, socketOf(c), config.clientIpHeader);
    if (address === null) return refuse(c, 400, "NO_CLIENT_ADDRESS");
    const visitor = visitorKey(address, config.visitorHashSecret);
    if (visitor === null) return refuse(c, 400, "NO_CLIENT_ADDRESS");
    if (!(await isHuman(body.data.turnstileToken, address))) return refuse(c, 403, "HUMAN_CHECK_FAILED");

    const at = now();
    let issued: { token: string; expiresAt: Date };
    try {
      issued = await db.transaction(async (tx) => {
        if (!(await countKeyIssue(tx, visitor, MCP_LIMITS.keysPerVisitorPerDay, at))) throw new IssueRefused("VISITOR_LIMIT");
        if (!(await reserve(tx, [{ key: KEYS_BUCKET, amount: 1 }], at))) throw new IssueRefused("KEY_BUDGET");
        return issueToken(tx);
      });
    } catch (error) {
      if (error instanceof IssueRefused) return refuse(c, 429, error.code);
      throw error;
    }
    return c.json({ token: issued.token, expiresAt: issued.expiresAt.toISOString() }, 201, { "Cache-Control": "no-store" });
  });

  return route;
}
