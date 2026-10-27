import { z } from "zod";
import { briefContentSchema, briefSchema } from "@/lib/brief";
import type { BriefContent, BriefState } from "@/lib/brief";

// The browser talks to the agent server directly. Server-side reads use
// VASAL_API_URL instead, which is never sent to the browser.
export const API_BASE = (process.env.NEXT_PUBLIC_VASAL_API_URL || "https://api.vasal.site").replace(
  /\/+$/,
  "",
);

export type Failure = { ok: false; status: number; code: string };
export type Result<T> = { ok: true; value: T } | Failure;

// The code for a request that never got an answer.
export const NETWORK = "NETWORK";

const candidateSchema = z.object({
  id: z.string(),
  name: z.string(),
  publisher: z.string().nullish(),
});

const snapshotSchema = z.object({
  status: z.string(),
  createdAt: z.string(),
  errorCode: z.string().nullable(),
  candidates: z.array(candidateSchema).optional(),
});

const stepSchema = z.object({ tool: z.string(), ok: z.boolean(), label: z.string() });

export type Candidate = z.infer<typeof candidateSchema>;
export type RunSnapshot = z.infer<typeof snapshotSchema>;
export type LiveStep = z.infer<typeof stepSchema>;
export type BriefAnswer = { kind: "done"; brief: BriefContent } | { kind: "pending" };

export async function call<T>(
  path: string,
  init: RequestInit,
  schema: z.ZodType<T>,
): Promise<Result<T>> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, init);
  } catch {
    return { ok: false, status: 0, code: NETWORK };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // An answer with no JSON body is read through its status alone.
  }
  if (!response.ok) {
    const code =
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
        ? body.error
        : "UNEXPECTED";
    return { ok: false, status: response.status, code };
  }
  const parsed = schema.safeParse(body);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, status: response.status, code: "UNEXPECTED" };
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export function startRun(show: string, turnstileToken: string) {
  return call("/runs", post({ show, turnstileToken }), z.object({ runId: z.string() }));
}

export function readRun(runId: string) {
  return call(`/runs/${runId}`, { cache: "no-store" }, snapshotSchema);
}

export function confirmRun(runId: string, candidateId: string) {
  return call(`/runs/${runId}/confirm`, post({ candidateId }), z.object({ ok: z.literal(true) }));
}

const briefAnswerSchema = z.union([
  z
    .object({ brief: briefContentSchema })
    .transform((value): BriefAnswer => ({ kind: "done", brief: value.brief })),
  z.object({ status: z.literal("pending") }).transform((): BriefAnswer => ({ kind: "pending" })),
]);

export function requestBrief(runId: string, guestId: string) {
  return call(`/runs/${runId}/brief`, post({ guestId }), briefAnswerSchema);
}

export function readBrief(runId: string, guestId: string): Promise<Result<BriefState>> {
  return call(`/runs/${runId}/briefs/${guestId}`, { cache: "no-store" }, briefSchema);
}

export type RunEvents = {
  onStep: (id: number, step: LiveStep) => void;
  onCandidates: (id: number, candidates: Candidate[]) => void;
  onBoard: (id: number) => void;
  onDone: (id: number) => void;
  onFailed: (id: number, code: string | null) => void;
  // True when the stream cannot be used any more and the caller should poll.
  onUnavailable: () => void;
};

const MAX_CONSECUTIVE_ERRORS = 3;
const candidatesSchema = z.object({ candidates: z.array(candidateSchema) });
const failedSchema = z.object({ code: z.string().nullish() });

// Follows a run's events. The server ends the stream by itself once the
// candidates are out, at done and at failed, so this closes the source then
// too, and a new one is opened after a confirm. A browser cannot send
// Last-Event-ID on a fresh source, so the server replays from the start and
// the caller skips ids it has already seen.
export function followRun(runId: string, handlers: RunEvents): () => void {
  const source = new EventSource(`${API_BASE}/runs/${runId}/events`);
  let errors = 0;

  const read = <T>(event: MessageEvent, schema: z.ZodType<T>): T | null => {
    errors = 0;
    try {
      const parsed = schema.safeParse(JSON.parse(String(event.data)));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };
  const idOf = (event: MessageEvent): number => Number(event.lastEventId) || 0;

  source.addEventListener("step", (event) => {
    const step = read(event, stepSchema);
    if (step) handlers.onStep(idOf(event), step);
  });
  source.addEventListener("candidates", (event) => {
    const value = read(event, candidatesSchema);
    if (value) handlers.onCandidates(idOf(event), value.candidates);
  });
  source.addEventListener("board", (event) => {
    errors = 0;
    handlers.onBoard(idOf(event));
  });
  source.addEventListener("done", (event) => {
    errors = 0;
    handlers.onDone(idOf(event));
  });
  source.addEventListener("failed", (event) => {
    const value = read(event, failedSchema);
    handlers.onFailed(idOf(event), value?.code ?? null);
  });
  source.onerror = () => {
    errors += 1;
    // A refused stream (503 STREAMS_FULL, 429 TOO_MANY_STREAMS) is closed for
    // good by the browser and cannot be read for its status, so a closed
    // source and three errors in a row both mean: poll instead.
    if (source.readyState === EventSource.CLOSED || errors >= MAX_CONSECUTIVE_ERRORS) {
      source.close();
      handlers.onUnavailable();
    }
  };

  return () => source.close();
}
