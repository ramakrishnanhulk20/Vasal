import { z } from "zod";
import { QlooError } from "./errors.js";
import type { QlooOperation } from "./request.js";

// Every object passes unknown keys through, because the Qloo docs disagree on
// response shapes (reference/qloo-docs/CORE-TECH.md section h, C1 to C8). Only
// the fields Vasal reads are checked. Optional fields accept null as well as
// absent, since the docs show both for "no value".

const OptionalNumber = z.number().nullish();

const AffinityHolder = z.object({ affinity: OptionalNumber }).passthrough();

const EntitySchema = z
  .object({
    entity_id: z.string().min(1),
    name: z.string(),
    popularity: OptionalNumber,
    query: AffinityHolder.nullish(),
    tags: z.array(z.object({}).passthrough()).nullish(),
    properties: AffinityHolder.nullish(),
  })
  .passthrough();

const EntityListResponse = z
  .object({ results: z.object({ entities: z.array(EntitySchema) }).passthrough() })
  .passthrough()
  .transform((response) => response.results.entities);

// Search recipes show a flat `results` array; the spec and Qloo's own client
// also accept `results.entities`. Both normalise to one entity list.
const SearchResponse = z.union([
  z
    .object({ results: z.array(EntitySchema) })
    .passthrough()
    .transform((response) => response.results),
  EntityListResponse,
]);

const Breakdown = z.record(z.string(), z.number());

const DemographicSchema = z
  .object({
    entity_id: z.string().min(1),
    query: z.object({ age: Breakdown, gender: Breakdown }).passthrough(),
  })
  .passthrough();

const DemographicsResponse = z
  .object({ results: z.object({ demographics: z.array(DemographicSchema) }).passthrough() })
  .passthrough()
  .transform((response) => response.results.demographics);

const TrendRowSchema = z
  .object({
    date: z.string(),
    population_percentile: OptionalNumber,
    population_rank: OptionalNumber,
    population_rank_velocity: OptionalNumber,
    velocity_fold_change: OptionalNumber,
    population_percent_delta: OptionalNumber,
  })
  .passthrough();

const TrendingResponse = z
  .object({ results: z.object({ trending: z.array(TrendRowSchema) }).passthrough() })
  .passthrough()
  .transform((response) => response.results.trending);

const CompareTagSchema = z
  .object({
    tag_id: z.string().min(1),
    name: z.string(),
    query: z.object({ score: OptionalNumber }).passthrough().nullish(),
  })
  .passthrough();

const CompareResponse = z
  .object({ results: z.object({ tags: z.array(CompareTagSchema) }).passthrough() })
  .passthrough()
  .transform((response) => response.results.tags);

// The tag search page shows `id`; taste analysis shows `tag_id`. Qloo's own
// harness reads either, so one of them must be present.
const TagSchema = z
  .object({
    id: z.string().min(1).optional(),
    tag_id: z.string().min(1).optional(),
    name: z.string(),
  })
  .passthrough()
  .refine((tag) => tag.id !== undefined || tag.tag_id !== undefined);

const TagsResponse = z
  .object({ results: z.object({ tags: z.array(TagSchema) }).passthrough() })
  .passthrough()
  .transform((response) => response.results.tags);

export type QlooEntity = z.infer<typeof EntitySchema>;
export type QlooDemographic = z.infer<typeof DemographicSchema>;
export type QlooTrendRow = z.infer<typeof TrendRowSchema>;
export type QlooCompareTag = z.infer<typeof CompareTagSchema>;
export type QlooTag = z.infer<typeof TagSchema>;

export type QlooResponseFor<Op extends QlooOperation["op"]> = {
  search: QlooEntity[];
  insights: QlooEntity[];
  demographics: QlooDemographic[];
  trending: QlooTrendRow[];
  compare: QlooCompareTag[];
  tags: QlooTag[];
}[Op];

const RESPONSE_SCHEMAS = {
  search: SearchResponse,
  insights: EntityListResponse,
  demographics: DemographicsResponse,
  trending: TrendingResponse,
  compare: CompareResponse,
  tags: TagsResponse,
} as const;

/**
 * Checks a decoded Qloo response body against the shape expected for `op` and
 * returns the normalised list Vasal reads.
 *
 * Throws QlooError("QLOO_SCHEMA") when the body does not match. The thrown
 * error never carries the body.
 */
export function parseQlooResponse<Op extends QlooOperation>(op: Op, json: unknown): QlooResponseFor<Op["op"]> {
  const parsed = RESPONSE_SCHEMAS[op.op].safeParse(json);
  if (!parsed.success) throw new QlooError("QLOO_SCHEMA");
  return parsed.data as QlooResponseFor<Op["op"]>;
}
