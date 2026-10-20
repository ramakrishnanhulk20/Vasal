import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { routePath } from "hono/route";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { createMcpRoute } from "../mcp/server.js";
import { visitorKey } from "../net/visitor-key.js";
import type { Db } from "../store/db.js";
import { StoreError } from "../store/errors.js";
import { liveRunsEnabled } from "../store/flags.js";
import type { AgentPort } from "./agent-port.js";
import { acquireInflightSlot, countVisitorRun, releaseInflightSlot } from "./caps.js";
import type { ServerConfig } from "./config.js";
import { ServerError } from "./errors.js";
import { clientAddressFrom, isAllowedPost } from "./guards.js";
import { createAgentKeysRoute } from "./keys-route.js";
import {
  appendEvent,
  claimBrief,
  claimRunStatus,
  createRun,
  getBoardGuest,
  getBrief,
  getBriefClaim,
  getCandidate,
  getRun,
  listBoard,
  listCandidates,
  listEventsAfter,
  listShowcase,
  setRunStatus,
  type RunInput,
} from "./runs.js";
import { formatSseFrame, parseLastEventId, SSE_PING } from "./sse.js";
import { TURNSTILE_ACTIONS } from "./turnstile.js";

export type AppDeps = {
  db: Db;
  config: ServerConfig;
  verifyTurnstile: (token: string, remoteIp: string | null, expectedAction: string) => Promise<boolean>;
  agent: AgentPort;
  socketAddress: (c: Context) => string | null; // main.ts passes getConnInfo; tests pass a stub
  now?: () => Date;
  streamPollMs?: number; // default 500
  streamLifetimeMs?: number; // default 600000
};

const MAX_BODY_BYTES = 8 * 1024;
const MAX_SHOW_LENGTH = 300;
const MAX_EXCLUSIONS = 25;
const MAX_EXCLUSION_LENGTH = 100;
const MAX_TOKEN_LENGTH = 2_048;
const MAX_BRIEFS_PER_RUN = 5;
const MAX_STREAMS_PER_RUN = 3;
const STREAM_PING_MS = 15_000;
const DEFAULT_STREAM_POLL_MS = 500;
const MAX_STREAM_POLL_MS = 60_000;
const DEFAULT_STREAM_LIFETIME_MS = 600_000;
const EVENT_PAGE = 100;
const EVENTS_ROUTE = "/runs/:id/events";
const SSE_HEADERS = { "Content-Type": "text/event-stream; charset=utf-8" };

// String length, not code points, because createRun caps the same way and the
// two must agree. The check runs after NFC, which can lengthen text (C8.1).
const showText = z
  .string()
  .transform((text) => text.normalize("NFC").trim())
  .pipe(z.string().min(1).max(MAX_SHOW_LENGTH));
const exclusion = z
  .string()
  .transform((text) => text.trim())
  .pipe(z.string().min(1).max(MAX_EXCLUSION_LENGTH));

const startBody = z.strictObject({
  show: showText,
  exclude: z.array(exclusion).max(MAX_EXCLUSIONS).optional(),
  turnstileToken: z.string().min(1).max(MAX_TOKEN_LENGTH),
});

// Only a server-issued id may come back. A URL, a name or entity data has no
// field to arrive in, and any extra key fails the strict schema (C6.2).
const confirmBody = z.strictObject({ candidateId: z.uuid() });
const briefBody = z.strictObject({ guestId: z.uuid() });

function errorCodeOf(error: unknown): string {
  return error instanceof ServerError || error instanceof StoreError ? error.code : "UNEXPECTED";
}

// Only the fixed route pattern and a fixed code are logged. Messages, bodies,
// headers and addresses never are, because any of them can carry attacker
// text or a secret (C3.6).
function logFailure(route: string, error: unknown): void {
  console.error(JSON.stringify({ level: "error", route, code: errorCodeOf(error) }));
}

function wholeMs(value: number | undefined, fallback: number, max: number): number {
  const ms = value ?? fallback;
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > max) throw new ServerError("SRV_BAD_INPUT");
  return ms;
}

function isRunPath(path: string): boolean {
  return path === "/runs" || path.startsWith("/runs/");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The server-issued id is written last so stored data can never replace it.
// Data that is not an object counts as missing (C6.5).
function withIds(items: Array<{ id: string; data: unknown }>): Array<Record<string, unknown>> {
  return items.flatMap((item) => (isPlainObject(item.data) ? [{ ...item.data, id: item.id }] : []));
}

// A stored candidate also holds its feed URL, which the server keeps to itself
// and fetches only through a handle (C1.5). The page gets the same fields the
// candidates event carries, chosen by name so a new stored field stays private.
const PUBLIC_CANDIDATE_FIELDS = ["appleId", "name", "publisher", "qlooName"] as const;

function publicCandidates(items: Array<{ id: string; data: unknown }>): Array<Record<string, unknown>> {
  return items.flatMap((item) => {
    if (!isPlainObject(item.data)) return [];
    const data = item.data as Record<string, unknown>;
    const picked: Record<string, unknown> = { id: item.id };
    for (const field of PUBLIC_CANDIDATE_FIELDS) if (field in data) picked[field] = data[field];
    return [picked];
  });
}

/**
 * Builds the public agent server. Routes: GET /health, GET /showcase, POST
 * /runs, GET /runs/:id, GET /runs/:id/events, POST /runs/:id/confirm, POST
 * /runs/:id/brief, GET /runs/:id/briefs/:guestId, POST /agent-keys
 * (keys-route.ts) and POST /mcp (mcp/server.ts); every other path and
 * method gives 404 NOT_FOUND, and there is no way to list visitor runs
 * (C6.1). GET /showcase lists only the runs the operator promoted (C6.3),
 * from storage alone, cacheable for 60 seconds and open to indexing.
 * Confirm and brief act only on ids the server issued for that run (C6.2).
 * Each guest's brief is claimed once, at most 5 claims per run, and a brief
 * that failed may be asked for once more; after a second failure the POST
 * gives 409 { error: "BRIEF_FAILED", code } (C5.8), even with live runs
 * off, which refuse only a brief that would call the model. GET
 * /runs/:id/briefs/:guestId reports { status: "done", brief },
 * { status: "pending" }, { status: "failed", code } or { status: "none" }
 * from storage alone. The event stream writes only formatSseFrame
 * frames and pings (C3.3), allows 3 open streams per run in this process, and
 * ends at a done or failed event, a finished and drained run, or
 * streamLifetimeMs; pings follow the `now` clock, checked once per poll.
 * Every POST that can spend must pass the Origin and Content-Type check, the
 * 8 KiB body cap and a strict body schema before anything else runs (C5.5,
 * C8.1), and a GET or HEAD never spends (C5.4). POST /runs also needs a
 * human check solved on this site for the run-start action (C5.9), checked
 * before the visitor is counted. Refusals are JSON
 * { error: CODE } and change nothing. An unexpected failure gives 500
 * { error: "INTERNAL" } and one log line holding only the route pattern and
 * a fixed code (C3.6). Throws ServerError("SRV_BAD_INPUT") while building if
 * streamPollMs is outside 1 to 60,000 or streamLifetimeMs outside 1 to
 * 600,000.
 */
export function createApp(deps: AppDeps): Hono {
  const { db, config, agent } = deps;
  const now = deps.now ?? (() => new Date());
  const pollMs = wholeMs(deps.streamPollMs, DEFAULT_STREAM_POLL_MS, MAX_STREAM_POLL_MS);
  const lifetimeMs = wholeMs(deps.streamLifetimeMs, DEFAULT_STREAM_LIFETIME_MS, DEFAULT_STREAM_LIFETIME_MS);
  const openStreams = new Map<string, number>();
  const app = new Hono();

  const refuse = (c: Context, status: ContentfulStatusCode, code: string): Response => c.json({ error: code }, status);

  const socketOf = (c: Context): string | null => {
    try {
      return deps.socketAddress(c);
    } catch {
      return null;
    }
  };

  const isHuman = async (token: string, address: string): Promise<boolean> => {
    try {
      return (await deps.verifyTurnstile(token, address, TURNSTILE_ACTIONS.runStart)) === true;
    } catch {
      return false;
    }
  };

  const failRun = async (runId: string, code: string): Promise<void> => {
    try {
      await setRunStatus(db, runId, "failed", code, now());
    } catch (error) {
      // SRV_NOT_FOUND here means the run already finished, and its own ending
      // stands. Anything else is a real failure.
      if (error instanceof ServerError && error.code === "SRV_NOT_FOUND") return;
      throw error;
    }
    await appendEvent(db, runId, "failed", { code }, now());
  };

  // The request has already been answered when this runs. A run that stops
  // without finishing is saved as failed, never left looking alive (C6.4).
  const inBackground = (route: string, runId: string, work: () => Promise<void>, onSettled?: () => Promise<void>): void => {
    void (async () => {
      try {
        await work();
      } catch (error) {
        logFailure(route, error);
        await failRun(runId, "AGENT_ERROR").catch((failure: unknown) => logFailure(route, failure));
      } finally {
        if (onSettled) await onSettled().catch((failure: unknown) => logFailure(route, failure));
      }
    })();
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

  const readBody = async <S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S> | null> => {
    let value: unknown;
    try {
      value = JSON.parse(await c.req.text());
    } catch {
      return null;
    }
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : null;
  };

  // The caller has already counted this stream in openStreams; shutdown gives
  // that place back exactly once, whichever way the stream ends.
  const eventStream = (runId: string, afterSeq: number, signal: AbortSignal): ReadableStream<Uint8Array> => {
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let closed = false;
    let wake = (): void => {};
    let lifetime: ReturnType<typeof setTimeout> | undefined;

    const shutdown = (closeBody: boolean): void => {
      if (closed) return;
      closed = true;
      clearTimeout(lifetime);
      signal.removeEventListener("abort", onAbort);
      wake();
      const open = (openStreams.get(runId) ?? 1) - 1;
      if (open > 0) openStreams.set(runId, open);
      else openStreams.delete(runId);
      if (closeBody) {
        try {
          controller?.close();
        } catch {
          // The reader already went away, so there is nothing to close.
        }
      }
    };
    const onAbort = (): void => shutdown(false);
    const emit = (text: string): void => {
      if (!closed) controller?.enqueue(encoder.encode(text));
    };
    const pause = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });

    const pump = async (): Promise<void> => {
      let last = afterSeq;
      let lastPing = now().getTime();
      let drainedAfterFinish = false;
      while (!closed) {
        // The status is read before the events, so no event written before a
        // run finished can be missed. A writer that sets the status first and
        // appends its last event after gets one more poll to land it.
        const run = await getRun(db, runId);
        // After shutdown no new query starts, so a closed stream stops
        // touching the database as soon as its current query returns.
        if (closed) return;
        const events = await listEventsAfter(db, runId, last, EVENT_PAGE);
        if (closed) return;
        for (const event of events) {
          emit(formatSseFrame(event.event, event.seq, event.data));
          last = event.seq;
          if (event.event === "done" || event.event === "failed") return;
        }
        if (events.length === EVENT_PAGE) continue;
        if (run === null || run.status === "done" || run.status === "failed") {
          if (drainedAfterFinish) return;
          drainedAfterFinish = true;
        }
        const clock = now().getTime();
        if (clock - lastPing >= STREAM_PING_MS) {
          emit(SSE_PING);
          lastPing = clock;
        }
        await pause(pollMs);
      }
    };

    return new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
        lifetime = setTimeout(() => shutdown(true), lifetimeMs);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) shutdown(false);
        void pump()
          .catch((error: unknown) => logFailure(EVENTS_ROUTE, error))
          .finally(() => shutdown(true));
      },
      cancel() {
        shutdown(false);
      },
    });
  };

  app.use("*", async (c, next) => {
    await next();
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    c.res.headers.set("Referrer-Policy", "no-referrer");
    if (isRunPath(c.req.path)) {
      c.res.headers.set("X-Robots-Tag", "noindex");
      c.res.headers.set("Cache-Control", "no-store");
    }
  });

  // Mounted before cors() so /mcp never sends a CORS header: the MCP door
  // refuses every Origin, the opposite of the website's rule (D2.6).
  app.route("/mcp", createMcpRoute({ db, agent, config, now }));

  app.use(
    "*",
    cors({
      origin: config.appOrigin,
      allowMethods: ["GET", "POST"],
      allowHeaders: ["Content-Type", "Last-Event-ID"],
      credentials: false,
    }),
  );

  app.get("/health", async (c) => c.json({ ok: true, liveRuns: await liveRunsEnabled(db) }));

  // Read by the home page, so it only reads storage: no agent, human check,
  // kill switch or meter is touched (C5.4), and only the operator's promote
  // command decides what it lists (C6.3). Unlike a visitor's run it is meant
  // to be public, so it may be cached and indexed.
  app.get("/showcase", async (c) => c.json({ runs: await listShowcase(db) }, 200, { "Cache-Control": "public, max-age=60" }));

  app.post("/runs", sameSiteJson, smallBody, async (c) => {
    const body = await readBody(c, startBody);
    if (body === null) return refuse(c, 400, "BAD_INPUT");
    if (!(await liveRunsEnabled(db))) return refuse(c, 503, "LIVE_RUNS_OFF");

    const headerValue = config.clientIpHeader === null ? null : (c.req.header(config.clientIpHeader) ?? null);
    const address = clientAddressFrom(headerValue, socketOf(c), config.clientIpHeader);
    if (address === null) return refuse(c, 400, "NO_CLIENT_ADDRESS");
    if (!(await isHuman(body.turnstileToken, address))) return refuse(c, 403, "HUMAN_CHECK_FAILED");
    const visitor = visitorKey(address, config.visitorHashSecret);
    if (visitor === null) return refuse(c, 400, "NO_CLIENT_ADDRESS");

    // The slot is taken before the visitor's count, so a busy site does not
    // use up anyone's daily runs. From here every exit gives the slot back
    // unless a run now holds it.
    if (!(await acquireInflightSlot(db, config.maxInflightRuns))) return refuse(c, 429, "BUSY");
    const input: RunInput = { show: body.show, exclude: body.exclude ?? [] };
    let runId: string | null = null;
    try {
      if (await countVisitorRun(db, visitor, config.runsPerVisitorPerDay, now())) {
        runId = await createRun(db, input, now());
      }
    } finally {
      if (runId === null) await releaseInflightSlot(db);
    }
    if (runId === null) return refuse(c, 429, "VISITOR_LIMIT");

    const started = runId;
    inBackground(
      "agent.startRun",
      started,
      () => agent.startRun(started, input),
      () => releaseInflightSlot(db),
    );
    return c.json({ runId: started }, 202);
  });

  app.get("/runs/:id", async (c) => {
    const run = await getRun(db, c.req.param("id"));
    if (run === null) return refuse(c, 404, "NOT_FOUND");
    const [candidates, board] = await Promise.all([listCandidates(db, run.id), listBoard(db, run.id)]);
    return c.json({
      id: run.id,
      status: run.status,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
      errorCode: run.errorCode,
      candidates: publicCandidates(candidates),
      // Only a finished run shows its board, so a run that stopped early is
      // never shown with partial results (C6.4).
      board: run.status === "done" ? withIds(board) : [],
    });
  });

  app.get("/runs/:id/events", async (c) => {
    const run = await getRun(db, c.req.param("id"));
    if (run === null) return refuse(c, 404, "NOT_FOUND");
    // Nobody reads a HEAD body, so a stream opened for one would hold one of
    // the run's places until its lifetime ran out.
    if (c.req.method === "HEAD") return c.body(null, 200, SSE_HEADERS);

    const open = openStreams.get(run.id) ?? 0;
    if (open >= MAX_STREAMS_PER_RUN) return refuse(c, 429, "TOO_MANY_STREAMS");
    openStreams.set(run.id, open + 1);
    const afterSeq = parseLastEventId(c.req.header("last-event-id"));
    return c.body(eventStream(run.id, afterSeq, c.req.raw.signal), 200, SSE_HEADERS);
  });

  app.post("/runs/:id/confirm", sameSiteJson, smallBody, async (c) => {
    const body = await readBody(c, confirmBody);
    if (body === null) return refuse(c, 400, "BAD_INPUT");
    const run = await getRun(db, c.req.param("id"));
    if (run === null) return refuse(c, 404, "NOT_FOUND");
    if ((await getCandidate(db, run.id, body.candidateId)) === null) return refuse(c, 404, "UNKNOWN_CANDIDATE");
    // Continuing is where a run spends most of its Qloo calls and model
    // tokens, so it obeys the kill switch and takes an in-flight slot just as
    // a start does (C5.7, C5.8). A run refused here stays awaiting_confirm.
    if (!(await liveRunsEnabled(db))) return refuse(c, 503, "LIVE_RUNS_OFF");
    if (!(await acquireInflightSlot(db, config.maxInflightRuns))) return refuse(c, 429, "BUSY");
    // The status move is the lock: of two confirms at once, one moves the
    // run and the other gets 409, so the agent continues once.
    let claimed = false;
    try {
      claimed = await claimRunStatus(db, run.id, "awaiting_confirm", "running", now());
    } finally {
      if (!claimed) await releaseInflightSlot(db);
    }
    if (!claimed) return refuse(c, 409, "NOT_AWAITING");
    const { candidateId } = body;
    inBackground(
      "agent.continueRun",
      run.id,
      () => agent.continueRun(run.id, candidateId),
      () => releaseInflightSlot(db),
    );
    return c.json({ ok: true }, 202);
  });

  app.post("/runs/:id/brief", sameSiteJson, smallBody, async (c) => {
    const body = await readBody(c, briefBody);
    if (body === null) return refuse(c, 400, "BAD_INPUT");
    const run = await getRun(db, c.req.param("id"));
    if (run === null) return refuse(c, 404, "NOT_FOUND");
    if (run.status !== "done") return refuse(c, 409, "NOT_READY");
    const { guestId } = body;
    if ((await getBoardGuest(db, run.id, guestId)) === null) return refuse(c, 404, "UNKNOWN_GUEST");

    const brief = await getBrief(db, run.id, guestId);
    if (brief !== null) return c.json({ brief }, 200);
    // Only new model spend stops when live runs are off (C5.7), so a stored
    // brief, a brief that failed for good and one already being written are
    // all answered from storage first. claimBrief below stays the only gate
    // that lets a model call through.
    const held = await getBriefClaim(db, run.id, guestId);
    if (held?.status === "failed" && held.attempts === 2) return c.json({ error: "BRIEF_FAILED", code: held.errorCode }, 409);
    if (held?.status === "pending" || held?.status === "done") return c.json({ status: "pending" }, 202);
    if (!(await liveRunsEnabled(db))) return refuse(c, 503, "LIVE_RUNS_OFF");

    const claim = await claimBrief(db, run.id, guestId, MAX_BRIEFS_PER_RUN, now());
    if (claim === "limit") return refuse(c, 429, "BRIEF_LIMIT");
    if (claim === "failed") {
      // A claim that failed twice never changes again, so this reads the code claimBrief saw.
      const failed = await getBriefClaim(db, run.id, guestId);
      return c.json({ error: "BRIEF_FAILED", code: failed?.errorCode ?? null }, 409);
    }
    if (claim === "claimed") {
      // A failed brief leaves the finished run and its board alone.
      void (async () => agent.writeBrief(run.id, guestId))().catch((error: unknown) =>
        logFailure("agent.writeBrief", error),
      );
    }
    return c.json({ status: "pending" }, 202);
  });

  // Polled by the page while a brief is written, so it only reads storage:
  // no agent, human check, kill switch or meter is touched (C5.4).
  app.get("/runs/:id/briefs/:guestId", async (c) => {
    const run = await getRun(db, c.req.param("id"));
    if (run === null) return refuse(c, 404, "NOT_FOUND");
    const guestId = c.req.param("guestId");
    if ((await getBoardGuest(db, run.id, guestId)) === null) return refuse(c, 404, "UNKNOWN_GUEST");

    const brief = await getBrief(db, run.id, guestId);
    if (brief !== null) return c.json({ status: "done", brief });
    // A done claim whose brief cannot be read counts as missing (C6.5).
    const claim = await getBriefClaim(db, run.id, guestId);
    if (claim?.status === "pending") return c.json({ status: "pending" });
    if (claim?.status === "failed") return c.json({ status: "failed", code: claim.errorCode });
    return c.json({ status: "none" });
  });

  app.route("/", createAgentKeysRoute(deps));

  app.notFound((c) => refuse(c, 404, "NOT_FOUND"));

  app.onError((error, c) => {
    let route = "unknown";
    try {
      route = routePath(c);
    } catch {
      // The pattern is only a label for the log line.
    }
    logFailure(route, error);
    return c.json({ error: "INTERNAL" }, 500);
  });

  return app;
}
