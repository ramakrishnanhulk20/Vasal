import { z } from "zod";
import { QlooError } from "./errors.js";

// Both game spellings are kept on purpose: the docs disagree and the probe
// records which one the hackathon host accepts.
export const ENTITY_TYPES = [
  "urn:entity:artist",
  "urn:entity:book",
  "urn:entity:brand",
  "urn:entity:movie",
  "urn:entity:person",
  "urn:entity:place",
  "urn:entity:podcast",
  "urn:entity:tv_show",
  "urn:entity:videogame",
  "urn:entity:video_game",
  "urn:entity:destination",
  "urn:entity:locality",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export type QlooOperation =
  | { op: "search"; query: string; types: EntityType[]; take?: number }
  | {
      op: "insights";
      filterType: EntityType;
      signalEntities: string[];
      take?: number;
      popularityMax?: number;
      popularityMin?: number;
      explainability?: boolean;
      resultEntities?: string[];
      releaseDateMin?: string;
      publicationYearMin?: number;
    }
  | { op: "demographics"; signalEntities: string[] }
  | { op: "trending"; filterType: EntityType; entity: string; startDate: string; endDate: string }
  | { op: "compare"; a: string[]; b: string[]; take?: number }
  | { op: "tags"; query: string; take?: number };

export type BuiltRequest = {
  method: "GET";
  url: URL;
  path: string;
  params: Array<[string, string]>;
  cacheKey: string;
};

const MAX_TEXT_LENGTH = 300;
const MAX_IDS_PER_LIST = 25;

// In a `u` regex a surrogate pair is one code point, so this matches only a
// lone surrogate. URLSearchParams would silently turn one into U+FFFD, and the
// logged params would then differ from what was sent.
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

const Text = z
  .string()
  .min(1)
  .max(MAX_TEXT_LENGTH)
  .refine((value) => !LONE_SURROGATE.test(value));
const EntityId = z.string().regex(/^[A-Za-z0-9-]{8,64}$/);
const EntityIds = z.array(EntityId).min(1).max(MAX_IDS_PER_LIST);
const Take = z.int().min(1).max(50);
const Popularity = z.number().min(0).max(1);
const IsoDate = z.iso.date();
const Year = z.int().min(1000).max(9999);
const EntityTypeSchema = z.enum(ENTITY_TYPES);

const SearchOperation = z
  .object({
    op: z.literal("search"),
    query: Text,
    types: z.array(EntityTypeSchema).min(1).max(ENTITY_TYPES.length),
    take: Take.optional(),
  })
  .strict();

const InsightsOperation = z
  .object({
    op: z.literal("insights"),
    filterType: EntityTypeSchema,
    signalEntities: EntityIds,
    take: Take.optional(),
    popularityMax: Popularity.optional(),
    popularityMin: Popularity.optional(),
    explainability: z.boolean().optional(),
    resultEntities: EntityIds.optional(),
    releaseDateMin: IsoDate.optional(),
    publicationYearMin: Year.optional(),
  })
  .strict()
  .refine(
    (op) => op.popularityMin === undefined || op.popularityMax === undefined || op.popularityMin <= op.popularityMax,
  );

const DemographicsOperation = z
  .object({
    op: z.literal("demographics"),
    signalEntities: EntityIds,
  })
  .strict();

const TrendingOperation = z
  .object({
    op: z.literal("trending"),
    filterType: EntityTypeSchema,
    entity: EntityId,
    startDate: IsoDate,
    endDate: IsoDate,
  })
  .strict()
  .refine((op) => op.startDate <= op.endDate);

const CompareOperation = z
  .object({
    op: z.literal("compare"),
    a: EntityIds,
    b: EntityIds,
    take: Take.optional(),
  })
  .strict();

const TagsOperation = z
  .object({
    op: z.literal("tags"),
    query: Text,
    take: Take.optional(),
  })
  .strict();

/** Strict schema for every Qloo operation Vasal may send. Unknown keys are rejected. */
export const QlooOperationSchema = z.discriminatedUnion("op", [
  SearchOperation,
  InsightsOperation,
  DemographicsOperation,
  TrendingOperation,
  CompareOperation,
  TagsOperation,
]);

type CheckedOperation = z.infer<typeof QlooOperationSchema>;
type Field = [string, string | undefined];

// Every list Vasal sends is read by Qloo as a set, so duplicates are dropped
// and the order is fixed. Equal requests then share one cache entry.
const asSet = (values: readonly string[]) => [...new Set(values)].sort().join(",");
const optionalSet = (values: readonly string[] | undefined) => (values === undefined ? undefined : asSet(values));
const optionalText = (value: number | boolean | undefined) => (value === undefined ? undefined : String(value));

function pathAndFields(op: CheckedOperation): { path: string; fields: Field[] } {
  switch (op.op) {
    case "search":
      return {
        path: "/search",
        fields: [
          ["query", op.query],
          ["types", asSet(op.types)],
          ["take", optionalText(op.take)],
        ],
      };
    case "insights":
      return {
        path: "/v2/insights",
        fields: [
          ["filter.type", op.filterType],
          ["signal.interests.entities", asSet(op.signalEntities)],
          ["take", optionalText(op.take)],
          ["filter.popularity.max", optionalText(op.popularityMax)],
          ["filter.popularity.min", optionalText(op.popularityMin)],
          ["feature.explainability", optionalText(op.explainability)],
          ["filter.results.entities", optionalSet(op.resultEntities)],
          ["filter.release_date.min", op.releaseDateMin],
          ["filter.publication_year.min", optionalText(op.publicationYearMin)],
        ],
      };
    case "demographics":
      return {
        path: "/v2/insights",
        fields: [
          ["filter.type", "urn:demographics"],
          ["signal.interests.entities", asSet(op.signalEntities)],
        ],
      };
    case "trending":
      return {
        path: "/v2/trending",
        fields: [
          ["filter.type", op.filterType],
          ["signal.interests.entities", op.entity],
          ["filter.start_date", op.startDate],
          ["filter.end_date", op.endDate],
        ],
      };
    case "compare":
      return {
        path: "/v2/analysis/compare",
        fields: [
          ["a.signal.interests.entities", asSet(op.a)],
          ["b.signal.interests.entities", asSet(op.b)],
          ["take", optionalText(op.take)],
        ],
      };
    case "tags":
      return {
        path: "/v2/tags",
        fields: [
          ["filter.query", op.query],
          ["take", optionalText(op.take)],
        ],
      };
  }
}

// Plain code-unit order rather than localeCompare, so the cache key never
// depends on the locale of the machine that built it.
const byKeyThenValue = ([keyA, valueA]: [string, string], [keyB, valueB]: [string, string]) =>
  keyA < keyB ? -1 : keyA > keyB ? 1 : valueA < valueB ? -1 : valueA > valueB ? 1 : 0;

/**
 * Builds the one GET request for a Qloo operation. The client sends exactly
 * this request and the cache keys on exactly this `cacheKey`, so the two can
 * never disagree (threat model C7.1).
 *
 * Only the origin of `baseUrl` is used. The path is a fixed literal per
 * operation, and every value enters the query through URLSearchParams as one
 * encoded parameter, so text such as `x&take=500#y` stays a single value
 * (threat model C2.3).
 *
 * Throws QlooError("QLOO_BAD_INPUT") when `op` fails QlooOperationSchema.
 */
export function buildQlooRequest(baseUrl: URL, op: QlooOperation): BuiltRequest {
  const checked = QlooOperationSchema.safeParse(op);
  if (!checked.success) throw new QlooError("QLOO_BAD_INPUT");

  const { path, fields } = pathAndFields(checked.data);
  const params = fields
    .filter((field): field is [string, string] => field[1] !== undefined)
    .sort(byKeyThenValue);
  const query = new URLSearchParams(params).toString();

  const url = new URL(path, baseUrl.origin);
  url.search = query;

  return { method: "GET", url, path, params, cacheKey: `GET ${url.host}${path}?${query}` };
}
