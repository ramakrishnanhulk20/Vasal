import { XMLParser } from "fast-xml-parser";
import { cleanText } from "../text/normalize.js";
import { FeedError } from "./errors.js";

export type FeedEpisode = {
  title: string;
  publishedAt: string | null;
  guid: string | null;
  durationSec: number | null;
  description: string | null;
};

export type ParsedFeed = { title: string; authors: string[]; episodes: FeedEpisode[] };

const MAX_DEPTH = 32;
// The 10 MB cap on decoded bytes is what bounds memory. This cap only stops
// a document made of nothing but empty tags, and it sits well above what a
// real feed needs: 50,000 refused rich feeds of about 2,000 items, around 25
// elements each, before the 2,000-episode cap could apply.
const MAX_ELEMENTS = 300_000;
const MAX_EPISODES = 2_000;
const MAX_TITLE_CHARS = 500;
const MAX_DATE_CHARS = 100;
const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_AUTHORS = 4;
const MAX_AUTHOR_CHARS = 200;
const DOCTYPE = /<!doctype/i;
// fast-xml-parser 5.11.2 throws a plain Error with this exact text when
// maxNestedTags is exceeded. The depth test pins it, so a library change that
// alters the text shows up as a failing test instead of a wrong error code.
const LIBRARY_DEPTH_MESSAGE = "Maximum nested tags exceeded";

const XML_ESCAPES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const XML_REFERENCE = /&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos));/g;
const SECONDS = /^\d{1,9}$/;
const MINUTES_SECONDS = /^(\d{1,7}):([0-5]?\d)$/;
const HOURS_MINUTES_SECONDS = /^(\d{1,5}):([0-5]?\d):([0-5]?\d)$/;

type XmlNode = Record<string, unknown>;

function isNode(value: unknown): value is XmlNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asList(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function isXmlChar(codePoint: number): boolean {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

// The parser's entity processing stays off (C1.7), which leaves the escapes
// XML itself defines as raw text: every SmartLess title arrives as
// `&quot;Name&quot;`. This decodes only those five names and numeric
// character references, in a single pass, so `&amp;quot;` becomes `&quot;`
// and never `"`. Output is never longer than input, and nothing a document
// declares can be expanded because a DOCTYPE is refused before parsing.
function decodeXmlEscapes(text: string): string {
  return text.replace(XML_REFERENCE, (whole: string, dec?: string, hex?: string, name?: string) => {
    if (name !== undefined) return XML_ESCAPES[name] ?? whole;
    const codePoint = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? "", 16);
    return isXmlChar(codePoint) ? String.fromCodePoint(codePoint) : whole;
  });
}

function textOf(value: unknown): string | null {
  const node = Array.isArray(value) ? value[0] : value;
  if (typeof node === "string") {
    const text = decodeXmlEscapes(node).trim();
    return text === "" ? null : text;
  }
  if (isNode(node)) return textOf(node["#text"]);
  return null;
}

function capChars(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = "";
  let count = 0;
  for (const char of text) {
    if (count === max) break;
    out += char;
    count++;
  }
  return out;
}

function cappedText(value: unknown, max: number): string | null {
  const text = textOf(value);
  return text === null ? null : capChars(text, max);
}

// Podcasts did not exist before 2000, and a date days ahead is a feed error,
// not an episode. Out-of-range dates read as unknown, because one stray 1970
// would otherwise say a show's feed was checked "back to Jan 1970".
const EARLIEST_EPISODE_MS = Date.UTC(2000, 0, 1);
const FUTURE_SLACK_MS = 2 * 24 * 60 * 60 * 1_000;

function isoDate(value: unknown): string | null {
  const text = textOf(value);
  if (text === null || text.length > MAX_DATE_CHARS) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms) || ms < EARLIEST_EPISODE_MS || ms > Date.now() + FUTURE_SLACK_MS) return null;
  return new Date(ms).toISOString();
}

function durationSeconds(value: unknown): number | null {
  const text = textOf(value);
  if (text === null) return null;
  if (SECONDS.test(text)) return Number(text);
  const minutes = MINUTES_SECONDS.exec(text);
  if (minutes) return Number(minutes[1]) * 60 + Number(minutes[2]);
  const hours = HOURS_MINUTES_SECONDS.exec(text);
  if (hours) return Number(hours[1]) * 3600 + Number(hours[2]) * 60 + Number(hours[3]);
  return null;
}

// Bounded, so a stray "<" with no ">" after it costs at most this many steps
// and stays in the text instead of swallowing the rest of it.
const HTML_TAG = /<[^<>]{0,500}>/g;
const HTML_ENTITY = /&(?:#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/gi;

// Trimmed between cleaning and the cap, so spaces left where tags were never
// use up the cap.
function plainText(text: string, maxChars: number): string {
  const whole = cleanText(text, { maxChars: Number.POSITIVE_INFINITY }).trim();
  return cleanText(whole, { maxChars }).trim();
}

// Show notes arrive as HTML, usually inside CDATA. Tags and the entities left
// after the XML escapes are decoded become spaces, so "Peyton<br>Manning"
// still reads as two words.
function descriptionOf(summary: unknown, description: unknown): string | null {
  const text = textOf(summary) ?? textOf(description);
  if (text === null) return null;
  const plain = plainText(text.replace(HTML_TAG, " ").replace(HTML_ENTITY, " "), MAX_DESCRIPTION_CHARS);
  return plain === "" ? null : plain;
}

function episode(title: unknown, date: unknown, guid: unknown, duration: unknown, description: string | null): FeedEpisode {
  return {
    title: capChars(textOf(title) ?? "", MAX_TITLE_CHARS),
    publishedAt: isoDate(date),
    guid: cappedText(guid, MAX_TITLE_CHARS),
    durationSec: durationSeconds(duration),
    description,
  };
}

// The names a show's own feed gives for who makes it. They are the hosts far
// more often than a guest, so they only ever leave people off the board.
function authorsOf(channel: XmlNode): string[] {
  const owners = asList(channel["itunes:owner"]).map((owner) => (isNode(owner) ? owner["itunes:name"] : undefined));
  const authors: string[] = [];
  for (const value of [...asList(channel["itunes:author"]), ...owners]) {
    const text = textOf(value);
    const name = text === null ? "" : plainText(text, MAX_AUTHOR_CHARS);
    if (name !== "" && !authors.includes(name)) authors.push(name);
    if (authors.length === MAX_AUTHORS) break;
  }
  return authors;
}

function newestFirst(episodes: FeedEpisode[]): FeedEpisode[] {
  const timeOf = (ep: FeedEpisode): number =>
    ep.publishedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(ep.publishedAt);
  return episodes
    .map((ep) => ({ ep, time: timeOf(ep) }))
    .sort((a, b) => (a.time === b.time ? 0 : b.time > a.time ? 1 : -1))
    .slice(0, MAX_EPISODES)
    .map(({ ep }) => ep);
}

function fromRss(channel: XmlNode): ParsedFeed {
  const episodes = asList(channel["item"])
    .filter(isNode)
    .map((item) =>
      episode(item["title"], item["pubDate"], item["guid"], item["itunes:duration"], descriptionOf(item["itunes:summary"], item["description"])),
    );
  return { title: capChars(textOf(channel["title"]) ?? "", MAX_TITLE_CHARS), authors: authorsOf(channel), episodes: newestFirst(episodes) };
}

function fromAtom(feed: XmlNode): ParsedFeed {
  const episodes = asList(feed["entry"])
    .filter(isNode)
    .map((entry) =>
      episode(
        entry["title"],
        entry["published"] ?? entry["updated"],
        entry["id"],
        entry["itunes:duration"],
        descriptionOf(entry["itunes:summary"], entry["description"]),
      ),
    );
  return { title: capChars(textOf(feed["title"]) ?? "", MAX_TITLE_CHARS), authors: authorsOf(feed), episodes: newestFirst(episodes) };
}

/**
 * Reads an RSS 2.0 (rss > channel > item) or Atom (feed > entry) document
 * into a show title, its authors and its newest 2,000 episodes, newest
 * first. Titles are capped at 500 characters. Episodes with no readable date
 * sort last. Each episode's description is its itunes:summary, else its
 * description, with HTML tags and entities taken out, cleaned (cleanText)
 * and capped at 2,000 characters, or null when none is left. authors are the
 * channel's itunes:author and itunes:owner's itunes:name, in that order,
 * cleaned, each capped at 200 characters, duplicates dropped, at most 4.
 *
 * Throws FeedError:
 * - FEED_DOCTYPE_REJECTED if the text holds a DOCTYPE declaration, in any
 *   case, checked before the parser sees a byte (C1.7).
 * - FEED_TOO_DEEP past 32 levels of nesting or 300,000 elements.
 * - FEED_NOT_A_FEED for anything that is not RSS 2.0 or Atom. Nothing from
 *   the body is kept in the error (C1.6).
 */
export function parseFeed(xml: string): ParsedFeed {
  if (DOCTYPE.test(xml)) throw new FeedError("FEED_DOCTYPE_REJECTED");

  let elements = 0;
  const parser = new XMLParser({
    processEntities: false,
    htmlEntities: false,
    ignoreAttributes: true,
    parseTagValue: false,
    parseAttributeValue: false,
    ignoreDeclaration: true,
    ignorePiTags: true,
    // The library counts open parents, not the element being opened, so
    // MAX_DEPTH - 1 is what lets exactly MAX_DEPTH levels through.
    maxNestedTags: MAX_DEPTH - 1,
    updateTag: (tagName: string) => {
      elements++;
      if (elements > MAX_ELEMENTS) throw new FeedError("FEED_TOO_DEEP");
      return tagName;
    },
  });

  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    if (err instanceof FeedError) throw err;
    if (err instanceof Error && err.message === LIBRARY_DEPTH_MESSAGE) throw new FeedError("FEED_TOO_DEEP");
    // Parser messages can quote tag names and text from the body, so they are dropped.
    throw new FeedError("FEED_NOT_A_FEED");
  }

  if (isNode(doc)) {
    const rss = doc["rss"];
    if (isNode(rss) && isNode(rss["channel"])) return fromRss(rss["channel"]);
    const atom = doc["feed"];
    if (isNode(atom)) return fromAtom(atom);
  }
  throw new FeedError("FEED_NOT_A_FEED");
}
