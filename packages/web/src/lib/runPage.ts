import { cache } from "react";
import { z } from "zod";
import { briefSchema } from "@/lib/brief";
import type { BriefState } from "@/lib/brief";
import { apiBase, boardGuestSchema, kolamSchema } from "@/lib/run";
import { MONTHS, flipSchema, formatRunDate } from "@/lib/showcase";

export const UNKNOWN_SHOW = "This show";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENTS_TIMEOUT_MS = 10_000;

const runGuestSchema = boardGuestSchema.extend({
  reach: z.string().nullable(),
  rising: z.string(),
});

const pastGuestsSchema = z.object({
  checked: z.boolean(),
  episodes: z.number(),
  since: z.string().nullable(),
  source: z.string(),
  feedName: z.string().nullable(),
  feedPublisher: z.string().nullable(),
  archiveTitles: z.number(),
});

const candidateSchema = z.object({
  id: z.string(),
  name: z.string(),
  publisher: z.string().nullish(),
});

const runDetailSchema = z.object({
  id: z.string(),
  status: z.string(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  errorCode: z.string().nullable(),
  candidates: z.array(candidateSchema).optional(),
  board: z.array(runGuestSchema).optional(),
  kolam: kolamSchema.nullish(),
  withoutQloo: flipSchema,
  pastGuests: pastGuestsSchema.nullish(),
});

const stepSchema = z.object({ tool: z.string(), ok: z.boolean(), label: z.string() });

export type RunGuest = z.infer<typeof runGuestSchema>;
export type RunDetail = z.infer<typeof runDetailSchema>;
export type { BriefState };
export type Step = z.infer<typeof stepSchema>;

export type RunPage =
  | { kind: "not-found" }
  | { kind: "unavailable" }
  | {
      kind: "ready";
      run: RunDetail;
      name: string;
      promoted: boolean;
      briefs: Record<string, BriefState>;
      steps: Step[] | null;
    };

async function loadPromotedIds(base: string): Promise<Set<string>> {
  try {
    const response = await fetch(`${base}/showcase`, { next: { revalidate: 300 } });
    if (!response.ok) return new Set();
    const parsed = z
      .object({ runs: z.array(z.object({ runId: z.string() })) })
      .parse(await response.json());
    return new Set(parsed.runs.map((run) => run.runId));
  } catch (error) {
    console.error("Showcase list unavailable, so no run counts as promoted", error);
    return new Set();
  }
}

// A run that is not on the showcase can have a brief written at any time, so
// its briefs are read fresh. A showcase run has them all stored.
async function loadBrief(
  base: string,
  runId: string,
  guestId: string,
  fresh: boolean,
): Promise<BriefState> {
  if (!UUID.test(guestId)) return { status: "none" };
  try {
    const response = await fetch(
      `${base}/runs/${runId}/briefs/${guestId}`,
      fresh ? { cache: "no-store" } : { next: { revalidate: 300 } },
    );
    if (!response.ok) throw new Error(`answered ${response.status}`);
    return briefSchema.parse(await response.json());
  } catch (error) {
    console.error(`Brief for ${guestId} could not be read`, error);
    return { status: "failed", code: null };
  }
}

// Server-sent events arrive as blocks of "id:", "event:" and "data:" lines
// separated by a blank line. Only the step events are kept.
export function parseSteps(text: string): Step[] {
  const steps: Step[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    let event = "";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (event !== "step" || data.length === 0) continue;
    try {
      const step = stepSchema.safeParse(JSON.parse(data.join("\n")));
      if (step.success) steps.push(step.data);
    } catch {
      // A malformed step is skipped, the rest still count.
    }
  }
  return steps;
}

// The timeout is a race, not an abort signal, so the response can still go
// through the Next data cache.
async function loadSteps(base: string, runId: string): Promise<Step[] | null> {
  const read = async () => {
    const response = await fetch(`${base}/runs/${runId}/events`, { next: { revalidate: 60 } });
    if (!response.ok) throw new Error(`answered ${response.status}`);
    return response.text();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), EVENTS_TIMEOUT_MS);
  });
  try {
    const steps = parseSteps(await Promise.race([read(), timeout]));
    return steps.length > 0 ? steps : null;
  } catch (error) {
    console.error("Run steps left out", error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const loadRunPage = cache(async (id: string): Promise<RunPage> => {
  if (!UUID.test(id)) return { kind: "not-found" };
  const runId = id.toLowerCase();
  const base = apiBase();

  // A finished run never changes, so its answer may be cached. A run still in
  // flight is read again with no cache, so a stale copy never hides its progress.
  const readRun = async (live: boolean) => {
    const response = await fetch(
      `${base}/runs/${runId}`,
      live ? { cache: "no-store" } : { next: { revalidate: 60 } },
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`answered ${response.status}`);
    return runDetailSchema.parse(await response.json());
  };

  let run: RunDetail;
  try {
    let read = await readRun(false);
    if (read && read.status !== "done") read = await readRun(true);
    if (read === null) return { kind: "not-found" };
    run = read;
  } catch (error) {
    console.error(`Run ${runId} could not be loaded`, error);
    return { kind: "unavailable" };
  }

  const name = run.pastGuests?.feedName ?? UNKNOWN_SHOW;
  const promotedIds = await loadPromotedIds(base);
  const promoted = promotedIds.has(runId);
  if (run.status !== "done") return { kind: "ready", run, name, promoted, briefs: {}, steps: null };
  if (!run.board || run.board.length === 0) return { kind: "unavailable" };

  const [briefList, steps] = await Promise.all([
    Promise.all(run.board.map((guest) => loadBrief(base, runId, guest.id, !promoted))),
    loadSteps(base, runId),
  ]);
  const briefs: Record<string, BriefState> = {};
  run.board.forEach((guest, index) => {
    const state = briefList[index];
    if (state) briefs[guest.id] = state;
  });
  return { kind: "ready", run, name, promoted, briefs, steps };
});

function monthYear(since: string): string | null {
  const match = /^(\d{4})-(\d{2})/.exec(since);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  return match && month ? `${month} ${match[1]}` : null;
}

// The items of the line under the show name, in order.
export function metaItems(run: RunDetail): string[] {
  const items: string[] = [];
  if (run.finishedAt) items.push(`Run ${formatRunDate(run.finishedAt)}`);
  items.push(`${run.board?.length ?? 0} guests`);
  const past = run.pastGuests;
  if (past?.checked) {
    const back = past.since ? monthYear(past.since) : null;
    const count = (value: number) => value.toLocaleString("en-US");
    items.push(
      `Past guests checked against ${count(past.episodes)} feed episodes${back ? ` back to ${back}` : ""}${
        past.archiveTitles > 0 ? ` and ${count(past.archiveTitles)} archived` : ""
      }`,
    );
  } else {
    items.push("Past guests not checked: the feed gave no episodes");
  }
  if (past && (past.source === "linked" || past.source === "pasted") && past.feedName) {
    items.push(`Feed: ${past.feedName}${past.feedPublisher ? ` by ${past.feedPublisher}` : ""}`);
  }
  return items;
}
