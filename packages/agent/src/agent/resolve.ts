import { pickPodcastMatch } from "../backtest/eligibility.js";
import { classifyInput } from "../feeds/classify.js";
import { FeedError } from "../feeds/errors.js";
import { FeedHandles } from "../feeds/handles.js";
import type { ShowCandidate } from "../feeds/lookup.js";
import type { ParsedFeed } from "../feeds/rss.js";
import { QlooError } from "../qloo/errors.js";
import type { MeteredQloo } from "../qloo/metered.js";
import type { QlooEntity } from "../qloo/schemas.js";
import type { RunInput } from "../server/runs.js";
import { cleanText } from "../text/normalize.js";
import { AgentError } from "./errors.js";

export type ResolvedShow = {
  appleId: string | null;
  name: string;
  publisher: string;
  feedHandleSource: "directory" | "visitor";
  feedUrl: string | null;
  qlooId: string;
  qlooName: string;
};

type Listed = Omit<ResolvedShow, "qlooId" | "qlooName">;

const MAX_CANDIDATES = 5;
const QLOO_SEARCH_TAKE = 5;
const MAX_NAME_CHARS = 200;
// The shape the Qloo request builder accepts for an entity id, so a matched
// id can always be sent back to Qloo later in the run.
const QLOO_ID = /^[A-Za-z0-9-]{8,64}$/;

// Directory, feed and Qloo text is written by strangers and is shown to the
// visitor and, as the Qloo name, told to the model, so it goes through the
// shared cleaner when the candidate is built (C3.7, C2.8). It is trimmed
// between cleaning and the cap, so spaces hidden behind an invisible
// character never use up the cap.
function clean(text: string): string {
  const whole = cleanText(text, { maxChars: Number.POSITIVE_INFINITY }).trim();
  return cleanText(whole, { maxChars: MAX_NAME_CHARS }).trim();
}

function fromDirectory(show: ShowCandidate): Listed {
  return {
    appleId: show.appleId,
    name: clean(show.name),
    publisher: clean(show.publisher),
    feedHandleSource: "directory",
    feedUrl: show.feedUrl?.href ?? null,
  };
}

async function qlooPodcastFor(qloo: MeteredQloo, name: string): Promise<{ id: string; name: string } | null> {
  let data: unknown;
  try {
    ({ data } = await qloo.call<QlooEntity[]>({ op: "search", query: name, types: ["urn:entity:podcast"], take: QLOO_SEARCH_TAKE }));
  } catch (error) {
    // A name the request builder refuses (a lone surrogate, for one) is a
    // candidate Qloo cannot be asked about, not a failed run.
    if (error instanceof QlooError && error.code === "QLOO_BAD_INPUT") return null;
    throw error;
  }
  if (!Array.isArray(data)) throw new QlooError("QLOO_SCHEMA");
  const podcasts = (data as QlooEntity[])
    .filter((entity) => QLOO_ID.test(entity.entity_id))
    .map((entity) => ({ id: entity.entity_id, name: clean(entity.name) }))
    .filter((entity) => entity.name !== "");
  const pick = pickPodcastMatch(name, podcasts);
  return pick.kind === "match" ? { id: pick.id, name: pick.name } : null;
}

// The handle is the only way this URL reaches the fetcher, the same path
// continueRun takes later (C1.5). A body that does not parse as a feed gives
// only the fixed code; none of its bytes go anywhere (C1.6).
async function feedTitle(
  url: URL,
  deps: { safeFetch: (url: URL) => Promise<{ body: string }>; parseFeed: (xml: string) => ParsedFeed },
): Promise<string> {
  const handles = new FeedHandles();
  const handle = handles.issue(url, "visitor");
  try {
    const { body } = await deps.safeFetch(handles.resolve(handle));
    return deps.parseFeed(body).title;
  } catch (error) {
    if (error instanceof FeedError) throw new AgentError("FEED_UNAVAILABLE");
    throw error;
  }
}

/**
 * Turns what the visitor typed into at most 5 show candidates, each tied to
 * exactly one Qloo podcast. classifyInput decides the kind (C8.2): a name is
 * searched in the podcast directory, and an Apple Podcasts link is looked up
 * by its id. Any other http or https URL is fetched once through a
 * FeedHandles handle issued for it (C1.5) and parsed with parseFeed; it
 * becomes one candidate named after the feed's title, with the URL's
 * hostname as its publisher and the URL kept so continueRun can fetch it
 * again through a fresh handle. Episode titles are not kept at this step.
 * Each candidate then gets one metered Qloo search (podcasts only, take 5)
 * and pickPodcastMatch; a candidate with no single match is dropped, never
 * guessed (C8.4). Names, publishers and Qloo names go through cleanText
 * (controls, invisible and direction characters removed, NFC) and are capped
 * at 200 code points (C3.7).
 *
 * Throws AgentError SHOW_NOT_FOUND when the directory has nothing,
 * FEED_UNAVAILABLE when a pasted feed fails to fetch or parse (any
 * FeedError), and SHOW_NO_QLOO_MATCH when every candidate was dropped or a
 * pasted feed has no title; FeedError from classifyInput or the directory
 * lookup; and any QlooError other than QLOO_BAD_INPUT (such as QLOO_BUDGET)
 * from the Qloo search.
 */
export async function resolveShow(
  input: RunInput,
  deps: {
    searchShows: (term: string) => Promise<ShowCandidate[]>;
    lookupShow: (appleId: string) => Promise<ShowCandidate | null>;
    safeFetch: (url: URL) => Promise<{ body: string }>;
    parseFeed: (xml: string) => ParsedFeed;
    qloo: MeteredQloo;
  },
): Promise<ResolvedShow[]> {
  const classified = classifyInput(input.show);
  let listed: Listed[];
  switch (classified.kind) {
    case "name":
      listed = (await deps.searchShows(classified.text)).map(fromDirectory);
      break;
    case "apple": {
      const show = await deps.lookupShow(classified.appleId);
      listed = show === null ? [] : [fromDirectory(show)];
      break;
    }
    case "feed": {
      const name = clean(await feedTitle(classified.url, deps));
      // An untitled feed has nothing to match, so no Qloo search is spent on it.
      if (name === "") throw new AgentError("SHOW_NO_QLOO_MATCH");
      listed = [
        {
          appleId: null,
          name,
          publisher: clean(classified.url.hostname),
          feedHandleSource: "visitor",
          feedUrl: classified.url.href,
        },
      ];
      break;
    }
  }

  const shows = listed.filter((show) => show.name !== "").slice(0, MAX_CANDIDATES);
  if (shows.length === 0) throw new AgentError("SHOW_NOT_FOUND");

  const matched: ResolvedShow[] = [];
  for (const show of shows) {
    const podcast = await qlooPodcastFor(deps.qloo, show.name);
    if (podcast !== null) matched.push({ ...show, qlooId: podcast.id, qlooName: podcast.name });
  }
  if (matched.length === 0) throw new AgentError("SHOW_NO_QLOO_MATCH");
  return matched;
}
