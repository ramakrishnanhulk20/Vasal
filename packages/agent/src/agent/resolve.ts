import { pickPodcastMatch } from "../backtest/eligibility.js";
import { classifyInput } from "../feeds/classify.js";
import type { ShowCandidate } from "../feeds/lookup.js";
import { QlooError } from "../qloo/errors.js";
import type { MeteredQloo } from "../qloo/metered.js";
import type { QlooEntity } from "../qloo/schemas.js";
import type { RunInput } from "../server/runs.js";
import { stripBidiControls } from "../text/normalize.js";
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

// Directory and Qloo text is written by strangers. It is shown to the
// visitor, so direction controls go (C3.7) and length is capped by whole
// code points.
function clean(text: string): string {
  return [...stripBidiControls(text).trim()].slice(0, MAX_NAME_CHARS).join("").trim();
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

/**
 * Turns what the visitor typed into at most 5 show candidates, each tied to
 * exactly one Qloo podcast. classifyInput decides the kind (C8.2): a name is
 * searched in the podcast directory, an Apple Podcasts link is looked up by
 * its id, and any other http or https URL becomes one candidate named after
 * the URL's host, with the URL kept so the server can fetch it later through
 * a FeedHandles handle (C1.5). Each candidate then gets one metered Qloo
 * search (podcasts only, take 5) and pickPodcastMatch; a candidate with no
 * single match is dropped, never guessed (C8.4). Names are cleaned of
 * direction controls and capped at 200 characters.
 *
 * Throws AgentError SHOW_NOT_FOUND when the directory has nothing and
 * SHOW_NO_QLOO_MATCH when every candidate was dropped, FeedError from
 * classifyInput or the directory lookup, and any QlooError other than
 * QLOO_BAD_INPUT (such as QLOO_BUDGET) from the Qloo search.
 */
export async function resolveShow(
  input: RunInput,
  deps: {
    searchShows: (term: string) => Promise<ShowCandidate[]>;
    lookupShow: (appleId: string) => Promise<ShowCandidate | null>;
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
    case "feed":
      listed = [
        {
          appleId: null,
          name: clean(classified.url.hostname),
          publisher: "",
          feedHandleSource: "visitor",
          feedUrl: classified.url.href,
        },
      ];
      break;
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
