import { classifyInput, type ClassifiedInput } from "../src/feeds/classify.js";
import { FeedError } from "../src/feeds/errors.js";
import { FeedHandles } from "../src/feeds/handles.js";
import { lookupShow, searchShows, type ShowCandidate } from "../src/feeds/lookup.js";
import { parseFeed } from "../src/feeds/rss.js";
import { safeFetch } from "../src/net/safe-fetch.js";

const USAGE = 'Usage: npm run feed:demo -- "<show name, Apple Podcasts link or feed URL>"';

// Titles and directory fields are written by podcasters. The same rule as
// scripts/youtube-demo.ts: control and direction characters are dropped so
// a title cannot move the cursor or reorder what the terminal shows.
const printable = (text: string) => text.replace(/[\p{Cc}\p{Bidi_Control}]/gu, "");

function describeCandidate(candidate: ShowCandidate, index: number): string {
  const publisher = candidate.publisher === "" ? "" : `, by ${printable(candidate.publisher)}`;
  const genre = candidate.genre === null ? "" : ` (${printable(candidate.genre)})`;
  const feed = candidate.feedUrl === null ? " [no usable feed URL]" : "";
  return `  ${index + 1}. ${printable(candidate.name)}${publisher}${genre}${feed}`;
}

async function issueHandle(input: ClassifiedInput, handles: FeedHandles): Promise<string> {
  if (input.kind === "feed") {
    console.log("Read the input as a feed URL.");
    return handles.issue(input.url, "visitor");
  }

  let candidates: ShowCandidate[];
  if (input.kind === "apple") {
    console.log(`Read the input as an Apple Podcasts link, id ${input.appleId}. Looking it up on Apple.`);
    const show = await lookupShow(input.appleId);
    candidates = show === null ? [] : [show];
  } else {
    console.log(`Read the input as a show name. Searching Apple for "${input.text}".`);
    candidates = await searchShows(input.text);
  }

  if (candidates.length === 0) throw new Error("Apple returned no matching podcast.");
  console.log("Candidates:");
  candidates.forEach((candidate, index) => console.log(describeCandidate(candidate, index)));

  const chosen = candidates[0];
  if (chosen === undefined || chosen.feedUrl === null) {
    throw new Error("The first candidate has no usable feed URL.");
  }
  console.log(`Taking candidate 1: ${printable(chosen.name)}`);
  return handles.issue(chosen.feedUrl, "directory");
}

async function main(): Promise<void> {
  const raw = process.argv.slice(2).join(" ");
  if (raw.trim() === "") {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  const handles = new FeedHandles();
  const handle = await issueHandle(classifyInput(raw), handles);
  const fetched = await safeFetch(handles.resolve(handle));
  const feed = parseFeed(fetched.body);

  console.log("");
  console.log(`Show: ${printable(feed.title)}`);
  console.log(`Episodes read: ${feed.episodes.length}`);
  console.log("Newest 5:");
  for (const episode of feed.episodes.slice(0, 5)) {
    console.log(`  ${episode.publishedAt?.slice(0, 10) ?? "no date"}  ${printable(episode.title)}`);
  }
}

main().catch((err: unknown) => {
  if (err instanceof FeedError) {
    console.error(`Stopped with ${err.code}: ${err.message}`);
  } else {
    console.error(err instanceof Error ? err.message : "Stopped with an unexpected error.");
  }
  process.exitCode = 1;
});
