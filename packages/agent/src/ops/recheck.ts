import { z } from "zod";
import { briefFillValues } from "../agent/brief.js";
import { isHost, isPastGuest } from "../agent/past-guests.js";
import { checkProse } from "../agent/prose.js";
import { CandidateRow, FEED_TIMEOUT_MS, fetchShowFeed, runContextFor, type AgentFeeds, type OperatorInput } from "../agent/runner.js";
import {
  getBrief,
  getCandidate,
  getRun,
  getWithoutQloo,
  listBoard,
  listCandidates,
  listEventsAfter,
  parseBoardGuest,
  storedBriefSchema,
  type StoredBoardGuest,
} from "../server/runs.js";
import type { Db } from "../store/db.js";
import { cleanText } from "../text/normalize.js";

/** One thing ops recheck found wrong with a stored run under today's checks. */
export type RecheckFinding =
  | { kind: "feed_unread" }
  | { kind: "board_row_unreadable"; rank: number }
  | { kind: "board_guest"; name: string; as: "host" | "past guest" }
  | {
      kind: "flip_guess";
      name: string;
      stored: { pastGuest: boolean; host: boolean };
      today: { pastGuest: boolean; host: boolean };
    }
  | { kind: "brief_unreadable"; guest: string }
  | { kind: "prose"; guest: string; field: string; reason: string };

/** Why ops recheck could not check a run at all. */
export type RecheckRefusal = "RECHECK_NOT_DONE" | "RECHECK_NO_BOARD" | "RECHECK_NO_SHOW";

/** What ops recheck found for one run. It never writes anything. */
export type RecheckReport =
  | { kind: "refused"; runId: string; code: RecheckRefusal }
  | {
      kind: "checked";
      runId: string;
      showName: string;
      feed: { read: boolean; episodes: number; since: string | null };
      archiveTitles: number;
      hosts: number;
      counts: { guests: number; guesses: number; briefs: number };
      findings: RecheckFinding[];
    };

const ANGLE_CHARS = 400;
// Any stored field is already within its schema's cap, and recheck is not
// asking whether it is too long, only what it says.
const ANY_LENGTH = 65_536;
// A run holds at most 500 events (appendEvent), so one page reaches them all.
const RUN_EVENT_PAGE = 500;
const MAX_SHOW_NAME_CHARS = 200;

// Only the confirmed candidate's id is read from the event, and getCandidate
// then returns a row only if that id belongs to this run (C6.2).
const BoardCandidate = z.object({ pastGuests: z.object({ candidateId: z.uuid() }) });

// A stored brief has its placeholders already filled with code's own values,
// such as "86%" and the guest's name. Those values, from the same
// briefFillValues the brief was filled with, are put back as their
// placeholders, longest first, so checkProse judges only what the model
// wrote, as it did when the brief was drafted.
function unfilled(text: string, guest: StoredBoardGuest): { text: string; placeholders: string[] } {
  const values = Object.entries(briefFillValues(guest, guest.showName, guest.sharedTags));
  let out = text;
  for (const [name, value] of values.filter(([, value]) => value !== "").sort((a, b) => b[1].length - a[1].length)) {
    out = out.split(value).join(`{{${name}}}`);
  }
  return { text: out, placeholders: values.map(([name]) => name) };
}

// Unless the guest's trend data says rising, no field may call them rising,
// the rule a brief is drafted under (agent/brief.ts). A link left in stored
// text is a finding even though checkProse would remove it.
function proseFinding(guest: StoredBoardGuest, field: string, text: string, placeholders: readonly string[]): RecheckFinding | null {
  const check = checkProse(text, { maxChars: ANY_LENGTH, placeholders, noTrendClaims: guest.rising.state !== "rising" });
  if (!check.ok) return { kind: "prose", guest: guest.name, field, reason: check.reason ?? "empty" };
  if (check.removed.links + check.removed.emails > 0) return { kind: "prose", guest: guest.name, field, reason: "link" };
  return null;
}

async function confirmedShow(db: Db, runId: string, showName: string): Promise<z.output<typeof CandidateRow> | null> {
  const board = (await listEventsAfter(db, runId, 0, RUN_EVENT_PAGE)).findLast((event) => event.event === "board");
  const named = BoardCandidate.safeParse(board?.data);
  if (named.success) {
    const row = CandidateRow.safeParse(await getCandidate(db, runId, named.data.pastGuests.candidateId));
    return row.success ? row.data : null;
  }
  // An older board event does not name its candidate, so the one stored
  // candidate whose Qloo name, cleaned as the runner cleans it, is the
  // board's show stands in; two or more is a refusal, never a guess.
  const shows = (await listCandidates(db, runId)).flatMap((row) => {
    const parsed = CandidateRow.safeParse(row.data);
    return parsed.success && cleanText(parsed.data.qlooName, { maxChars: MAX_SHOW_NAME_CHARS }).trim() === showName ? [parsed.data] : [];
  });
  return shows.length === 1 ? (shows[0] ?? null) : null;
}

/**
 * Operator use, read only: checks a done run's stored board, Without Qloo
 * flip and briefs against today's rules, so a showcase run made before a fix
 * can be found and remade. It rebuilds the run's past-guest index the way
 * continueRun does (runContextFor) from the run's confirmed candidate (the
 * one its board event names, or for an older event the one stored candidate
 * whose Qloo name is the board's show), that candidate's feed read once
 * through a FeedHandles handle (fetchShowFeed, 15 seconds), the run's own
 * exclusions and `operator`, the --host names and --archive episodes, which
 * should be the ones the seed used. It then reports each board guest that
 * isHost or isPastGuest now marks; each flip guess whose stored pastGuest or
 * host differs from today's answer (a host is host true and pastGuest
 * false); each board angle, and each field of each stored brief, that
 * checkProse now refuses or that still holds a link, with every value
 * briefFillValues gives (the fit, names, reach sentence, rising words,
 * brings label and tags) put back as placeholders first;
 * each board row and brief that does not read back (C6.5); and a feed it
 * could not read, since nothing then vouches for the past-guest check.
 *
 * It writes nothing and spends nothing metered: its only calls are SELECTs
 * and the one feed request. Refuses with RECHECK_NOT_DONE for a run that is
 * unknown or not done, RECHECK_NO_BOARD when no board row reads back, and
 * RECHECK_NO_SHOW when it cannot tell which stored candidate the run used.
 * Throws ServerError from the run store and whatever fetchShowFeed rethrows.
 */
export async function recheckRun(
  db: Db,
  deps: { feeds: Pick<AgentFeeds, "safeFetch" | "parseFeed">; operator?: OperatorInput },
  runId: string,
): Promise<RecheckReport> {
  const run = await getRun(db, runId);
  if (run === null || run.status !== "done") return { kind: "refused", runId, code: "RECHECK_NOT_DONE" };
  const findings: RecheckFinding[] = [];

  const board: Array<{ id: string; guest: StoredBoardGuest }> = [];
  (await listBoard(db, run.id)).forEach((row, index) => {
    const guest = parseBoardGuest(JSON.stringify(row.data));
    if (guest === null) findings.push({ kind: "board_row_unreadable", rank: index + 1 });
    else board.push({ id: row.id, guest });
  });
  const [first] = board;
  if (first === undefined) return { kind: "refused", runId, code: "RECHECK_NO_BOARD" };
  const { showName } = first.guest;

  const show = await confirmedShow(db, run.id, showName);
  if (show === null) return { kind: "refused", runId, code: "RECHECK_NO_SHOW" };
  const url = show.feedUrl === null ? null : URL.parse(show.feedUrl);
  const feed = url === null ? null : await fetchShowFeed(deps.feeds, url, show.feedHandleSource, FEED_TIMEOUT_MS);
  if (feed === null) findings.push({ kind: "feed_unread" });
  const operator = deps.operator ?? {};
  const ctx = runContextFor(show, feed, run.input.exclude, operator);
  const { index } = ctx.pastGuests;

  for (const { guest } of board) {
    if (isHost(index, guest.name)) findings.push({ kind: "board_guest", name: guest.name, as: "host" });
    else if (isPastGuest(index, guest.name)) findings.push({ kind: "board_guest", name: guest.name, as: "past guest" });
  }

  const flip = await getWithoutQloo(db, run.id);
  const guesses = flip?.status === "done" ? flip.guesses : [];
  for (const guess of guesses) {
    const host = isHost(index, guess.name);
    const today = { pastGuest: !host && isPastGuest(index, guess.name), host };
    if (today.pastGuest !== guess.pastGuest || today.host !== guess.host) {
      findings.push({ kind: "flip_guess", name: guess.name, stored: { pastGuest: guess.pastGuest, host: guess.host }, today });
    }
  }

  let briefs = 0;
  for (const { id, guest } of board) {
    const angle = proseFinding(guest, "angle on the board", cleanText(guest.angle, { maxChars: ANGLE_CHARS }), []);
    if (angle !== null) findings.push(angle);
    const stored = await getBrief(db, run.id, id);
    if (stored === null) continue;
    const brief = storedBriefSchema.safeParse(stored);
    if (!brief.success) {
      findings.push({ kind: "brief_unreadable", guest: guest.name });
      continue;
    }
    briefs += 1;
    const fields: Array<[string, string]> = [
      ["why", brief.data.why],
      ["brief angle", brief.data.angle],
      ...brief.data.questions.map((question, n): [string, string] => [`question ${n + 1}`, question]),
      ["pitch subject", brief.data.pitch_subject],
      ["pitch body", brief.data.pitch_body],
    ];
    for (const [field, text] of fields) {
      const back = unfilled(text, guest);
      const found = proseFinding(guest, field, back.text, back.placeholders);
      if (found !== null) findings.push(found);
    }
  }

  return {
    kind: "checked",
    runId,
    showName,
    feed: { read: feed !== null, episodes: ctx.pastGuests.titles, since: ctx.pastGuests.since },
    archiveTitles: ctx.pastGuests.archiveTitles,
    hosts: operator.hosts?.length ?? 0,
    counts: { guests: board.length, guesses: guesses.length, briefs },
    findings,
  };
}
