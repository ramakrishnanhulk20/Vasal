// Covers ops recheck (src/ops/recheck.ts) on PGlite with synthetic stored
// runs and a fake feed fetcher with the real feed parser: which board
// guests, flip flags and stored texts it reports under today's checks, how
// it finds the run's feed, its refusals, and that it writes nothing. It does
// not cover the real network, runRecheck's printed report (the ops selftest
// prints and checks it), or prose rules themselves (agent-prose does).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentFeeds } from "../src/agent/runner.js";
import { FeedError } from "../src/feeds/errors.js";
import { parseFeed } from "../src/feeds/rss.js";
import { recheckRun } from "../src/ops/recheck.js";
import { parseArchive } from "../src/ops/seed.js";
import { appendEvent, createRun, finishRun, putBoard, putBrief, putCandidates, setRunStatus } from "../src/server/runs.js";
import type { Db } from "../src/store/db.js";
import { migratedPglite } from "./helpers/pglite.js";

const MARKER = "MARKER-rech";
const SHOW = "Synthetic Show";
const FEED_URL = `https://feeds.example/${MARKER}.xml`;

let db: Db;

beforeEach(async () => {
  db = await migratedPglite();
});

afterEach(async () => {
  await db.close();
});

const candidate = (over: Record<string, unknown> = {}) => ({
  appleId: "1001",
  name: SHOW,
  publisher: "Synthetic Publisher",
  feedHandleSource: "directory",
  feedUrl: FEED_URL,
  qlooId: "00000000-0000-4000-8000-000000000500",
  qlooName: SHOW,
  ...over,
});

const guest = (n: number, over: Record<string, unknown> = {}) => ({
  personId: `00000000-0000-4000-8000-0000000009${String(n).padStart(2, "0")}`,
  name: `Synthetic Person ${n}`,
  fit: 0.86,
  fitKnown: true,
  fitRank: n,
  reach: "bookable",
  rising: { state: "steady", points: 0 },
  bringsNew: { segment: "age", label: "listeners 25 to 29", gap: 0.3 },
  sharedTags: ["synthetic taste"],
  angle: "Their fans already love this kind of talk.",
  showName: SHOW,
  ...over,
});

const QUESTIONS = ["What got you started?", "Who shaped you most?", "What surprised you?", "What comes next?", "What do fans get wrong?"];

// A brief as the runner stores it, placeholders already filled by code.
const brief = (name: string, over: Record<string, unknown> = {}) => ({
  why: `${name} has a fit of 86% with ${SHOW} listeners, and would bring listeners 25 to 29. ${name} is within reach, so booking is realistic.`,
  angle: "A talk about synthetic taste.",
  questions: QUESTIONS,
  pitch_subject: `${SHOW} would love to have ${name}`,
  pitch_body: `Hi team, could ${name} join ${SHOW} this month?`,
  removed: { links: 0, emails: 0 },
  ...over,
});

function fakeFeeds(feed: string | Error) {
  const fetched: URL[] = [];
  const feeds: Pick<AgentFeeds, "safeFetch" | "parseFeed"> = {
    safeFetch: async (url) => {
      fetched.push(url);
      if (feed instanceof Error) throw feed;
      return { body: feed };
    },
    parseFeed,
  };
  return { feeds, fetched };
}

const rss = (titles: string[], channel = "") =>
  `<?xml version="1.0"?><rss><channel><title>${SHOW}</title>${channel}${titles.map((title) => `<item><title>${title}</title></item>`).join("")}</channel></rss>`;

async function storedRun(
  opts: { guests?: unknown[]; candidates?: unknown[]; named?: boolean; guesses?: unknown[]; briefs?: Record<number, unknown> } = {},
) {
  const runId = await createRun(db, { show: SHOW, exclude: [] });
  await setRunStatus(db, runId, "running");
  const candidateIds = await putCandidates(db, runId, opts.candidates ?? [candidate()]);
  const guestIds = await putBoard(db, runId, opts.guests ?? [1, 2, 3].map((n) => guest(n)));
  const check = { checked: true, skipped: 0, titles: 2, since: null };
  const named = opts.named ?? true;
  await appendEvent(db, runId, "board", { guests: [], pastGuests: named ? { ...check, source: "directory", candidateId: candidateIds[0], archiveTitles: 0 } : check });
  if (opts.guesses !== undefined) await appendEvent(db, runId, "without_qloo", { status: "done", guesses: opts.guesses, unresolved: 0 });
  for (const [rank, stored] of Object.entries(opts.briefs ?? {})) await putBrief(db, runId, guestIds[Number(rank) - 1]!, stored);
  await finishRun(db, runId, "done", { name: "done", data: { guests: guestIds.length } });
  return { runId, guestIds };
}

async function snapshot(): Promise<string> {
  const tables = ["runs", "run_events", "run_candidates", "run_board", "run_briefs", "run_brief_claims", "usage_buckets"];
  const parts = await Promise.all(tables.map(async (table) => JSON.stringify((await db.query(`SELECT * FROM ${table} ORDER BY 1`)).rows)));
  return parts.join("\n");
}

const guess = (name: string, pastGuest: boolean, host?: boolean) => ({
  name,
  fit: 0.5,
  fitKnown: true,
  reach: "bookable",
  pastGuest,
  ...(host === undefined ? {} : { host }),
  onBoard: false,
});

describe("recheckRun", () => {
  it("finds nothing on a clean run, reads the confirmed candidate's feed once, and writes nothing", async () => {
    const names = [1, 2, 3].map((n) => `Synthetic Person ${n}`);
    const { runId } = await storedRun({ guesses: [guess("Ann Lee", false, false)], briefs: { 1: brief(names[0]!), 2: brief(names[1]!) } });
    const { feeds, fetched } = fakeFeeds(rss(["Episode one", "Episode two"]));
    const before = await snapshot();

    const report = await recheckRun(db, { feeds }, runId);

    expect(report).toEqual({
      kind: "checked",
      runId,
      showName: SHOW,
      feed: { read: true, episodes: 2, since: null },
      archiveTitles: 0,
      hosts: 0,
      counts: { guests: 3, guesses: 1, briefs: 2 },
      findings: [],
    });
    expect(fetched.map((url) => url.href)).toEqual([FEED_URL]);
    expect(await snapshot()).toBe(before);
  });

  it("reports a board guest a feed title, a feed author, a --host or an --archive line now names (A2-1, A2-N2)", async () => {
    const guests = [1, 2, 3, 4, 5].map((n) => guest(n));
    const { runId } = await storedRun({ guests });
    const { feeds } = fakeFeeds(rss(["Synthetic Person 1 looks back"], "<itunes:author>Synthetic Person 2</itunes:author>"));

    const report = await recheckRun(db, { feeds, operator: { hosts: ["Synthetic Person 3"], archive: parseArchive("E1: Synthetic Person 4 | \n") } }, runId);

    if (report.kind !== "checked") throw new Error(JSON.stringify(report));
    expect(report.findings).toEqual([
      { kind: "board_guest", name: "Synthetic Person 1", as: "past guest" },
      { kind: "board_guest", name: "Synthetic Person 2", as: "host" },
      { kind: "board_guest", name: "Synthetic Person 3", as: "host" },
      { kind: "board_guest", name: "Synthetic Person 4", as: "past guest" },
    ]);
    expect(report).toMatchObject({ archiveTitles: 1, hosts: 1 });
  });

  it("reports each flip guess whose stored flags differ from today's, a stored host shown as a past guest among them", async () => {
    const guesses = [guess("Jason Kelce", true), guess("Peyton Manning", false, false), guess("Ann Lee", false, false), guess("Eli Manning", true, false)];
    const { runId } = await storedRun({ guesses });
    const { feeds } = fakeFeeds(rss(["Peyton and Eli Manning, Super Bowl 59 Preview"]));

    const report = await recheckRun(db, { feeds, operator: { hosts: ["New Heights with Jason & Travis Kelce"] } }, runId);

    if (report.kind !== "checked") throw new Error(JSON.stringify(report));
    expect(report.findings).toEqual([
      { kind: "flip_guess", name: "Jason Kelce", stored: { pastGuest: true, host: false }, today: { pastGuest: false, host: true } },
      { kind: "flip_guess", name: "Peyton Manning", stored: { pastGuest: false, host: false }, today: { pastGuest: true, host: false } },
    ]);
  });

  it("reports an angle or brief field today's prose check refuses or that holds a link, but not the figures and names code filled in", async () => {
    const tricky = "Blink 182";
    const { runId } = await storedRun({
      guests: [guest(1, { angle: "Their 3 albums say it all." }), guest(2, { name: tricky, sharedTags: ["90s rock"] }), guest(3)],
      briefs: {
        1: brief("Synthetic Person 1"),
        2: brief(tricky, { angle: "A talk about 90s rock." }),
        3: brief("Synthetic Person 3", { questions: QUESTIONS.map((question, n) => (n === 1 ? "Were you arrested?" : question)), pitch_body: `See evil.example/${MARKER} now.` }),
      },
    });
    const { feeds } = fakeFeeds(rss(["Episode one"]));

    const report = await recheckRun(db, { feeds }, runId);

    if (report.kind !== "checked") throw new Error(JSON.stringify(report));
    expect(report.findings).toEqual([
      { kind: "prose", guest: "Synthetic Person 1", field: "angle on the board", reason: "digits" },
      { kind: "prose", guest: "Synthetic Person 3", field: "question 2", reason: "accusation" },
      { kind: "prose", guest: "Synthetic Person 3", field: "pitch body", reason: "link" },
    ]);
  });

  it("reports a feed it cannot read and a board row or brief that does not read back", async () => {
    const { runId } = await storedRun({ guests: [guest(1), { name: "no person id" }, guest(3)], briefs: { 3: { why: "only one field" } } });
    const { feeds } = fakeFeeds(new FeedError("FEED_TIMEOUT"));

    const report = await recheckRun(db, { feeds }, runId);

    if (report.kind !== "checked") throw new Error(JSON.stringify(report));
    expect(report.feed).toEqual({ read: false, episodes: 0, since: null });
    expect(report.findings).toEqual([
      { kind: "board_row_unreadable", rank: 2 },
      { kind: "feed_unread" },
      { kind: "brief_unreadable", guest: "Synthetic Person 3" },
    ]);
  });

  it("uses the one matching candidate for an older board event, and refuses when it cannot tell which feed the run read", async () => {
    const { feeds, fetched } = fakeFeeds(rss(["Synthetic Person 1 looks back"]));
    const older = await storedRun({ named: false, candidates: [candidate({ qlooName: "Another Show", feedUrl: "https://feeds.example/other.xml" }), candidate()] });
    expect(await recheckRun(db, { feeds }, older.runId)).toMatchObject({ kind: "checked", findings: [{ kind: "board_guest", name: "Synthetic Person 1" }] });
    expect(fetched.map((url) => url.href)).toEqual([FEED_URL]);

    const lookalikes = await storedRun({ named: false, candidates: [candidate(), candidate({ feedUrl: "https://feeds.example/lookalike.xml" })] });
    expect(await recheckRun(db, { feeds }, lookalikes.runId)).toEqual({ kind: "refused", runId: lookalikes.runId, code: "RECHECK_NO_SHOW" });

    const running = await createRun(db, { show: SHOW, exclude: [] });
    expect(await recheckRun(db, { feeds }, running)).toEqual({ kind: "refused", runId: running, code: "RECHECK_NOT_DONE" });
    expect(await recheckRun(db, { feeds }, "not-a-run")).toEqual({ kind: "refused", runId: "not-a-run", code: "RECHECK_NOT_DONE" });
    const unreadable = await storedRun({ guests: [{ name: "no person id" }] });
    expect(await recheckRun(db, { feeds }, unreadable.runId)).toEqual({ kind: "refused", runId: unreadable.runId, code: "RECHECK_NO_BOARD" });
    expect(fetched).toHaveLength(1);
  });
});
