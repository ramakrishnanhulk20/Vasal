import { z } from "zod";
import raw from "@/published/backtest.json";

const count = z.number().int().nonnegative();
const coefficient = z.number().min(-1).max(1);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const DROP_RULES = [
  "otherShow",
  "outsideWindow",
  "tooShort",
  "notOneGuest",
  "guestNotFound",
  "noFitScore",
  "other",
] as const;
export type DropRule = (typeof DROP_RULES)[number];

export const EXCLUDED_REASONS = ["no_podcast_match", "ambiguous_podcast", "no_channel"] as const;
export type ExcludedReason = (typeof EXCLUDED_REASONS)[number];

const bounds = z
  .strictObject({ low: coefficient, high: coefficient })
  .refine((b) => b.low <= b.high, "an interval has its ends the wrong way round");

// The pre-registered rule: above zero, and the low end of the interval above zero too.
const testResult = z
  .strictObject({
    rho: coefficient,
    low: coefficient,
    high: coefficient,
    supported: z.boolean(),
  })
  .refine((t) => t.low <= t.rho && t.rho <= t.high, "an estimate sits outside its interval")
  .refine(
    (t) => t.supported === (t.rho > 0 && t.low > 0),
    "a verdict disagrees with the pre-registered rule",
  );

const fifth = <N extends 1 | 2 | 3 | 4 | 5>(n: N) =>
  z.strictObject({ fifth: z.literal(n), medianRatio: z.number().positive(), episodes: count });

const schema = z
  .strictObject({
    dataset: z.string().min(1),
    datasetBuiltAt: z.iso.datetime(),
    window: z.strictObject({ from: day, to: day }),
    minimumMinutes: count,
    sample: z.strictObject({ shows: count, episodes: count }),
    h1: testResult,
    h2: testResult,
    bootstrap: z.strictObject({ iterations: count, seed: count }),
    fifths: z.tuple([fifth(1), fifth(2), fifth(3), fifth(4), fifth(5)]),
    shows: z
      .array(
        z.strictObject({
          name: z.string().min(1),
          episodes: count,
          cutShort: z.boolean(),
          rho: coefficient,
          rhoGivenFame: coefficient,
        }),
      )
      .min(1),
    excluded: z.array(
      z.strictObject({ name: z.string().min(1), reason: z.enum(EXCLUDED_REASONS) }),
    ),
    uploadsRead: count,
    drops: z.array(z.strictObject({ rule: z.enum(DROP_RULES), count })),
    precision: z.strictObject({ checked: count, correct: count }),
    sensitivity: z.strictObject({ episodes: count, h1: testResult, h2: testResult }),
    guestLevel: z.strictObject({
      guests: count,
      h1: bounds,
      h2: bounds,
      oneRowPerGuest: z.strictObject({ h1: coefficient, h2: coefficient }),
      resamples: z.strictObject({ h1: count, h2: count }),
      seed: count,
    }),
  })
  .superRefine((d, ctx) => {
    const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (sum(d.fifths.map((f) => f.episodes)) !== d.sample.episodes) {
      fail("the fifths do not add up to the sample");
    }
    if (sum(d.shows.map((s) => s.episodes)) !== d.sample.episodes) {
      fail("the shows do not add up to the sample");
    }
    if (d.shows.length !== d.sample.shows) fail("the show list is not the sample's show count");
    if (d.uploadsRead - sum(d.drops.map((x) => x.count)) !== d.sample.episodes) {
      fail("the funnel does not end at the sample");
    }
    if (d.precision.correct > d.precision.checked) fail("more names right than checked");
  });

export const backtest = schema.parse(raw);
export type Backtest = typeof backtest;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

function utcParts(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Not a date: ${value}`);
  return { day: date.getUTCDate(), month: MONTHS[date.getUTCMonth()], year: date.getUTCFullYear() };
}

export function dayMonthYear(value: string): string {
  const { day: d, month, year } = utcParts(value);
  return `${d} ${month} ${year}`;
}

export function monthYear(value: string): string {
  const { month, year } = utcParts(value);
  return `${month} ${year}`;
}

const COUNT_FORMAT = new Intl.NumberFormat("en-US");

export function formatCount(value: number): string {
  return COUNT_FORMAT.format(value);
}

// "0.140". A value that rounds to zero never carries a minus sign.
export function formatCorrelation(value: number): string {
  const text = Math.abs(value).toFixed(3);
  return value < 0 && Number(text) !== 0 ? `−${text}` : text;
}

export function formatRatio(value: number): string {
  return `${value.toFixed(2)}×`;
}

export function formatRange(low: number, high: number): string {
  return `${formatCorrelation(low)} to ${formatCorrelation(high)}`;
}

// Numbers under ten are words in running prose.
export function inWords(value: number): string {
  return Number.isInteger(value) && value >= 0 && value < 10 ? WORDS[value] : formatCount(value);
}

export type AxisTick = { value: number; text: string };
export type Axis = { min: number; max: number; ticks: AxisTick[] };

function ticksBetween(first: number, last: number, per: number, text: (v: number) => string) {
  const ticks: AxisTick[] = [];
  for (let k = first; k <= last; k += 1) ticks.push({ value: k / per, text: text(k / per) });
  return { min: first / per, max: last / per, ticks };
}

// One axis for every correlation strip on the page, so a dot sits at the same place in each.
export function correlationAxis(data: Backtest = backtest): Axis {
  const shown = [
    data.h1.low,
    data.h1.rho,
    data.h1.high,
    data.h2.low,
    data.h2.rho,
    data.h2.high,
    ...data.shows.flatMap((s) => [s.rho, s.rhoGivenFame]),
  ];
  const low = Math.min(-0.1, Math.min(...shown) - 0.05);
  const high = Math.max(0.5, Math.max(...shown) + 0.05);
  return ticksBetween(
    Math.floor(low * 10 + 1e-9),
    Math.ceil(high * 10 - 1e-9),
    10,
    (v) => (Math.abs(v) < 1e-9 ? "0.0" : v < 0 ? `−${Math.abs(v).toFixed(1)}` : v.toFixed(1)),
  );
}

// The ratio axis of the signature: a quarter below the smallest ratio to a quarter above the
// largest, rounded out to the nearest quarter.
export function ratioAxis(ratios: number[]): Axis {
  const first = Math.floor((Math.min(...ratios) - 0.25) * 4 + 1e-9);
  const last = Math.ceil((Math.max(...ratios) + 0.25) * 4 - 1e-9);
  return ticksBetween(first, last, 4, formatRatio);
}

export function dropLabel(rule: DropRule, data: Backtest = backtest): string {
  const span = `${monthYear(data.window.from)} to ${monthYear(data.window.to)}`;
  switch (rule) {
    case "otherShow":
      return "From another show on a shared channel";
    case "outsideWindow":
      return `Published outside ${span}`;
    case "tooShort":
      return `Shorter than ${data.minimumMinutes} minutes, such as clips and shorts`;
    case "notOneGuest":
      return "Title doesn't name exactly one guest";
    case "guestNotFound":
      return "Guest not found in Qloo under the same name";
    case "noFitScore":
      return "Qloo gave no fit score";
    case "other":
      return "Anything else";
  }
}

export const CUT_SHORT_HINT = "Its channel's 2,000 most recent uploads only reach part of the way back.";

export const EXCLUDED_TEXT: Record<ExcludedReason, string> = {
  no_podcast_match: "Qloo's podcast search found no podcast with this name.",
  ambiguous_podcast:
    "Two Qloo podcasts matched, and the rule drops the show rather than pick one.",
  no_channel: "It has no official full-episode YouTube channel.",
};

export type FunnelRow = {
  key: string;
  label: string;
  value: string;
  // Shares of uploadsRead: how much was in before this step, and how much is left after it.
  before: number;
  after: number;
  kind: "start" | "drop" | "kept";
};

export function funnelRows(data: Backtest = backtest): FunnelRow[] {
  const total = data.uploadsRead;
  const rows: FunnelRow[] = [
    { key: "start", label: "Uploads read", value: formatCount(total), before: 1, after: 1, kind: "start" },
  ];
  let remaining = total;
  for (const drop of data.drops) {
    if (drop.count === 0) continue;
    const before = remaining;
    remaining -= drop.count;
    rows.push({
      key: drop.rule,
      label: dropLabel(drop.rule, data),
      value: `−${formatCount(drop.count)}`,
      before: before / total,
      after: remaining / total,
      kind: "drop",
    });
  }
  rows.push({
    key: "kept",
    label: "Kept",
    value: formatCount(remaining),
    before: remaining / total,
    after: remaining / total,
    kind: "kept",
  });
  return rows;
}
