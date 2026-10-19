import { readFile, stat } from "node:fs/promises";
import { z } from "zod";

const MAX_POLICY_BYTES = 1024 * 1024;
const MAX_NOTE_LENGTH = 2_000;
// The same key rule as the meter (1 to 200 characters), narrowed to lower case
// words joined by colons. A segment must start with a letter, so a per-second
// key such as qloo:second:1729 can never be set from here.
const BUCKET_KEY = /^[a-z][a-z0-9_]*(:[a-z][a-z0-9_]*)*$/;

const Note = z.string().max(MAX_NOTE_LENGTH);

const BucketSchema = z
  .object({
    key: z.string().min(1).max(200).regex(BUCKET_KEY, "must be lower case words joined by colons"),
    window: z.enum(["day", "month"]),
    cap: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  // A month bucket tagged "day" would reset every midnight and let the month
  // be spent thirty times over, so the tag must appear in the key itself.
  .refine((bucket) => bucket.key.split(":").includes(bucket.window), {
    message: "the window must appear as a word in the key, for example qloo:month for month",
  });

const ProfileSchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    notes: Note.optional(),
    buckets: z.array(BucketSchema).min(1).max(50),
  })
  .strict()
  .refine((profile) => profile.from < profile.to, { message: "from must be before to" })
  .superRefine((profile, ctx) => {
    const seen = new Set<string>();
    for (const [index, bucket] of profile.buckets.entries()) {
      if (seen.has(bucket.key)) ctx.addIssue({ code: "custom", message: "duplicate bucket key", path: ["buckets", index, "key"] });
      seen.add(bucket.key);
    }
  });

const PolicySchema = z
  .object({
    notes: z.array(Note).max(50).optional(),
    profiles: z.array(ProfileSchema).min(1).max(100),
  })
  .strict()
  .superRefine((policy, ctx) => {
    // ISO dates compare correctly as text, and each profile covers
    // [from, to), so touching ranges are fine and any other contact is not.
    // Each profile is checked against the furthest end seen so far, not just
    // its neighbour, so a long profile cannot hide behind a short one.
    const order = policy.profiles
      .map((profile, index) => ({ profile, index }))
      .sort((a, b) => (a.profile.from < b.profile.from ? -1 : a.profile.from > b.profile.from ? 1 : 0));
    let furthest: (typeof order)[number] | undefined;
    for (const current of order) {
      if (furthest !== undefined && current.profile.from < furthest.profile.to) {
        ctx.addIssue({ code: "custom", message: `overlaps the profile starting ${furthest.profile.from}`, path: ["profiles", current.index] });
      }
      if (furthest === undefined || current.profile.to > furthest.profile.to) furthest = current;
    }
  });

export type BudgetPolicy = z.infer<typeof PolicySchema>;
export type PolicyProfile = BudgetPolicy["profiles"][number];
export type PolicyBucket = PolicyProfile["buckets"][number];
export type BucketWindow = PolicyBucket["window"];

/** Thrown for a policy file that cannot be read or does not pass the schema. */
export class PolicyError extends Error {
  override readonly name = "PolicyError";
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(message);
    this.issues = issues;
  }
}

const dayStartMs = (isoDate: string): number => Date.parse(`${isoDate}T00:00:00.000Z`);

/**
 * Checks a decoded policy against the schema: 1 to 100 profiles, each with
 * ISO dates where from is before to, 1 to 50 buckets with unique keys, a
 * window of "day" or "month" that also appears as a word in the key, and a cap
 * that is a non-negative safe integer. Profiles must not overlap; touching is
 * allowed because each covers its from date up to, not including, its to
 * date. Unknown fields are refused. Throws PolicyError listing up to 10
 * issues.
 */
export function parsePolicy(raw: unknown): BudgetPolicy {
  const parsed = PolicySchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 10)
      .map((issue) => `at ${issue.path.join(".") || "(top level)"}: ${issue.message}`);
    throw new PolicyError("The budget policy does not match its schema.", issues);
  }
  return parsed.data;
}

/**
 * Reads and checks the budget policy file at `path` (see parsePolicy). Throws
 * PolicyError when the file is missing, larger than 1 MB, not JSON, or fails
 * the schema.
 */
export async function loadPolicy(path: string): Promise<BudgetPolicy> {
  let text: string;
  try {
    if ((await stat(path)).size > MAX_POLICY_BYTES) throw new PolicyError("The budget policy file is larger than 1 MB.");
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof PolicyError) throw error;
    throw new PolicyError("The budget policy file could not be read.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new PolicyError("The budget policy file is not valid JSON.");
  }
  return parsePolicy(raw);
}

/**
 * Returns the profile covering `now`, meaning from 00:00 UTC on its from date
 * up to, not including, 00:00 UTC on its to date, or null when none does.
 * Throws RangeError for an invalid date.
 */
export function profileFor(policy: BudgetPolicy, now: Date): PolicyProfile | null {
  const at = now.getTime();
  if (!Number.isFinite(at)) throw new RangeError("now must be a valid date");
  return policy.profiles.find((profile) => dayStartMs(profile.from) <= at && at < dayStartMs(profile.to)) ?? null;
}
