import { QlooError } from "../qloo/errors.js";
import type { MeteredQloo } from "../qloo/metered.js";
import type { QlooEntity } from "../qloo/schemas.js";
import type { Db } from "../store/db.js";
import type { YouTubeClient } from "../youtube/client.js";
import { FIT_BATCH_SIZE, type FitScore, type PipelineDeps } from "./pipeline.js";
import { mulberry32 } from "./random.js";
import type { DatasetRow } from "./types.js";

const PODCAST_TAKE = 5;
const PERSON_TAKE = 1;
export const PRECISION_SAMPLE_SIZE = 50;
export const PRECISION_SAMPLE_SEED = 20261019;

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

// The metered client hands back lists that already passed the normalised
// schema, from the network or the cache. This is a last check that the call
// returned a list at all, so a wrong shape stops the build.
function entitiesOf(data: unknown): QlooEntity[] {
  if (!Array.isArray(data)) throw new QlooError("QLOO_SCHEMA");
  return data as QlooEntity[];
}

/**
 * Builds the backtest's live dependencies for buildDataset. Every Qloo call
 * goes through `qloo`, the same metered client the server uses, so each one
 * is cached, counted and capped (C9.2, C5.1); nothing here opens its own
 * client, reads a key or queries `db` directly. `db` is the database that
 * `qloo` and the YouTube meter were built over. `youtube`, `extractGuest`
 * and `now` are passed through unchanged.
 *
 * - findPodcasts: search with types [urn:entity:podcast], take 5, as
 *   { id, name }.
 * - resolvePerson: search with types [urn:entity:person], take 1. The top
 *   result as { id, name, popularity }, or null when there is none, when
 *   the request builder refuses the name (no call is made then) or when
 *   Qloo refuses the search with a 400, which the client gives as
 *   QLOO_BAD_INPUT; the pipeline counts the guest as unresolved. Its
 *   popularity is not used by the pipeline; a missing one is NaN, never a
 *   made-up number.
 * - fitScores: insights with filterType urn:entity:person, the podcast as
 *   the only signal, the batch as resultEntities and take set to the batch
 *   size, so Qloo is asked to return every id. Affinity is read from
 *   query.affinity, else properties.affinity, as the live runner does; ids
 *   not asked for, repeats and entities with no finite affinity are left out;
 *   a popularity that is not a finite number becomes null.
 *
 * fitScores throws RangeError for more than 25 ids and returns an empty map
 * for none. Every other failure, including QlooError("QLOO_BUDGET") when the
 * offline share is spent, is passed through so the build stops.
 */
export function createLivePipelineDeps(opts: {
  db: Db;
  qloo: MeteredQloo;
  youtube: YouTubeClient;
  extractGuest: PipelineDeps["extractGuest"];
  now: () => Date;
}): PipelineDeps {
  const { qloo, youtube, extractGuest, now } = opts;

  return {
    youtube,
    extractGuest,
    now,

    async findPodcasts(showName) {
      const { data } = await qloo.call<QlooEntity[]>({ op: "search", query: showName, types: ["urn:entity:podcast"], take: PODCAST_TAKE });
      return entitiesOf(data).map((entity) => ({ id: entity.entity_id, name: entity.name }));
    },

    async resolvePerson(name) {
      let data: unknown;
      try {
        ({ data } = await qloo.call<QlooEntity[]>({ op: "search", query: name, types: ["urn:entity:person"], take: PERSON_TAKE }));
      } catch (error) {
        if (error instanceof QlooError && error.code === "QLOO_BAD_INPUT") return null;
        throw error;
      }
      const top = entitiesOf(data)[0];
      if (top === undefined) return null;
      return { id: top.entity_id, name: top.name, popularity: isFiniteNumber(top.popularity) ? top.popularity : Number.NaN };
    },

    async fitScores(podcastId, personIds) {
      const ids = [...new Set(personIds)];
      if (ids.length > FIT_BATCH_SIZE) throw new RangeError(`fitScores takes at most ${FIT_BATCH_SIZE} ids per call`);
      const scores = new Map<string, FitScore>();
      if (ids.length === 0) return scores;

      const { data } = await qloo.call<QlooEntity[]>({
        op: "insights",
        filterType: "urn:entity:person",
        signalEntities: [podcastId],
        resultEntities: ids,
        take: ids.length,
      });
      const wanted = new Set(ids);
      for (const entity of entitiesOf(data)) {
        const affinity = entity.query?.affinity ?? entity.properties?.affinity;
        if (!wanted.has(entity.entity_id) || scores.has(entity.entity_id) || !isFiniteNumber(affinity)) continue;
        scores.set(entity.entity_id, { affinity, popularity: isFiniteNumber(entity.popularity) ? entity.popularity : null });
      }
      return scores;
    },
  };
}

/**
 * Draws the pre-registered precision sample: `size` kept rows (default 50)
 * chosen without replacement by a partial Fisher-Yates shuffle driven by
 * mulberry32(`seed`) (default 20261019), returned in dataset order. The same
 * rows and seed always give the same sample. With `size` or fewer rows, all
 * of them come back. Throws RangeError for a size that is not a positive
 * integer or a seed mulberry32 refuses.
 */
export function precisionSample(
  rows: readonly DatasetRow[],
  size: number = PRECISION_SAMPLE_SIZE,
  seed: number = PRECISION_SAMPLE_SEED,
): DatasetRow[] {
  if (!Number.isSafeInteger(size) || size < 1) throw new RangeError("size must be a positive whole number");
  const random = mulberry32(seed);
  const order = rows.map((_, index) => index);
  const take = Math.min(size, order.length);
  for (let i = 0; i < take; i += 1) {
    const j = i + Math.floor(random() * (order.length - i));
    const picked = order[j];
    const current = order[i];
    if (picked === undefined || current === undefined) throw new RangeError("sample index out of range");
    order[i] = picked;
    order[j] = current;
  }
  return order
    .slice(0, take)
    .sort((a, b) => a - b)
    .flatMap((index) => {
      const row = rows[index];
      return row === undefined ? [] : [row];
    });
}

// The person checking the sample opens this in a spreadsheet, which runs a
// cell that starts with = + - @ or a tab or carriage return as a formula.
// Such a cell gets a leading apostrophe, which spreadsheets hide and treat as
// "this is text". It does not cover other programs that read the file.
const FORMULA_START = /^[=+\-@\t\r]/;

function csvField(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * Renders the precision sample for hand checking as RFC 4180 CSV with the
 * columns video_id, title and extracted_name, every field quoted. It holds
 * only YouTube and model values, never a Qloo id or score, so it is not Qloo
 * data (C7.3); it still goes in the git-ignored data folder with the rest of
 * the run.
 */
export function precisionSampleCsv(rows: readonly DatasetRow[]): string {
  const lines = [["video_id", "title", "extracted_name"], ...rows.map((row) => [row.videoId, row.title, row.guestName])];
  return `${lines.map((fields) => fields.map(csvField).join(",")).join("\r\n")}\r\n`;
}
