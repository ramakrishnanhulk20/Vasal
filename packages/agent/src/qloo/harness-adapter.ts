import type { QlooToolClient, QlooWorkflowExecutionObserver } from "@qloo/qloo-harness";
import type { RawQlooPath } from "./client.js";
import { QlooError } from "./errors.js";
import type { MeteredRawQloo } from "./metered.js";

// The harness package names these shapes but does not export them.
type HarnessQuery = Parameters<QlooToolClient["insights"]>[0];
type HarnessOptions = Parameters<QlooToolClient["insights"]>[1];
type HarnessAnswer = Awaited<ReturnType<QlooToolClient["insights"]>>;

// The longest id list our own request builder accepts.
const MAX_LIST_ITEMS = 25;

/**
 * The observer find_person gives the harness. Its methods do nothing and
 * return nothing, so the harness writes no workflow log file anywhere.
 */
export const NO_OP_OBSERVER: QlooWorkflowExecutionObserver = {
  onExecution() {},
  onFailure() {},
};

const refused = (): QlooError => new QlooError("QLOO_BAD_INPUT");

function scalarText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw refused();
}

// Qloo's own client sends a list as one comma-joined value, so an item that
// held a comma would reach Qloo as two items. It is refused instead.
function valueText(value: unknown): string {
  if (!Array.isArray(value)) return scalarText(value);
  if (value.length === 0 || value.length > MAX_LIST_ITEMS) throw refused();
  const items = value.map(scalarText);
  if (items.some((item) => item === "" || item.includes(","))) throw refused();
  return items.join(",");
}

// undefined is how an optional key the harness left out reads at run time,
// so it is skipped. Every other value must be text, a finite number, a
// boolean or a short list of those. Keys are checked by buildRawQlooRequest.
function paramsOf(query: unknown): Array<[string, string]> {
  if (typeof query !== "object" || query === null || Array.isArray(query)) throw refused();
  const params: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.push([key, valueText(value)]);
  }
  return params;
}

function signalFor(own: AbortSignal | undefined, caller: AbortSignal | undefined): AbortSignal | undefined {
  if (own === undefined) return caller;
  if (caller === undefined) return own;
  return AbortSignal.any([own, caller]);
}

/**
 * The client Qloo's harness runs its workflows on, inside this process.
 *
 * Each method makes exactly one HTTP request through `deps.qloo.callRaw`, the
 * metered raw path: one slot from the run's own buckets, our cache keyed by
 * the full request, our client's single attempt with its timeout and with
 * redirects refused (C5.1, C5.2, C1). Paths are fixed per method:
 * searchEntities GET /search, entities GET /entities?entity_ids=, tags GET
 * /v2/tags, insights GET /v2/insights, compare GET /v2/analysis/compare,
 * trending GET /v2/trending. The harness's correlation id is not sent.
 *
 * A query key must match /^[a-z][a-z0-9_.]{0,63}$/ and a value must be text,
 * a finite number, a boolean or a list of 1 to 25 of those with no comma in
 * any item; anything else is refused before any slot or request. The
 * harness's per-call signal and `deps.signal` both go with the request, and
 * whichever fires first ends it.
 *
 * Each method resolves to the parsed JSON object body (at most 1,000,000
 * bytes) and rejects with a QlooError: QLOO_BAD_INPUT for a refused query,
 * QLOO_BUDGET, QLOO_TIMEOUT, or the code for an HTTP failure. It never
 * retries. A StoreError from the database passes through unchanged.
 */
export function createMeteredHarnessClient(deps: { qloo: MeteredRawQloo; signal?: AbortSignal }): QlooToolClient {
  const send = async (path: RawQlooPath, query: HarnessQuery | undefined, options: HarnessOptions): Promise<HarnessAnswer> => {
    const params = paramsOf(query);
    const signal = signalFor(deps.signal, options?.signal);
    const { data } = await deps.qloo.callRaw({ path, params }, signal === undefined ? {} : { signal });
    // A JSON object, which is all the harness asks of an answer: it reads
    // every field it uses through its own type checks.
    return data as HarnessAnswer;
  };

  return {
    searchEntities: (query, options) => send("/search", query, options),
    entities: (entityIds, options) => send("/entities", { entity_ids: entityIds }, options),
    tags: (query, options) => send("/v2/tags", query ?? {}, options),
    insights: (query, options) => send("/v2/insights", query, options),
    compare: (query, options) => send("/v2/analysis/compare", query, options),
    trending: (query, options) => send("/v2/trending", query, options),
  };
}
