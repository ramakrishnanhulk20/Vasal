import { z } from "zod";
import { apiBase, kolamSchema } from "@/lib/run";

export const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const showcaseSchema = z.object({
  runs: z.array(
    z.object({
      runId: z.string(),
      position: z.number(),
      showName: z.string(),
      finishedAt: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
      guests: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          fit: z.number().nullable(),
          fitKnown: z.boolean(),
        }),
      ),
      kolam: kolamSchema,
    }),
  ),
});

export const guessSchema = z.object({
  name: z.string(),
  fit: z.number().nullable(),
  fitKnown: z.boolean(),
  pastGuest: z.boolean(),
  host: z.boolean(),
  onBoard: z.boolean(),
});

export const flipSchema = z
  .object({ status: z.string(), guesses: z.array(guessSchema).optional() })
  .nullish();

const runDetailSchema = z.object({
  board: z.array(
    z.object({
      name: z.string(),
      fit: z.number().nullable(),
      fitKnown: z.boolean(),
      fitRank: z.number(),
    }),
  ),
  withoutQloo: flipSchema,
});

export type ProofGuess = z.infer<typeof guessSchema>;
export type ProofBoardGuest = z.infer<typeof runDetailSchema>["board"][number];
export type ShowcaseRun = z.infer<typeof showcaseSchema>["runs"][number] & { runDate: string };
export type ProofRun = {
  runId: string;
  position: number;
  showName: string;
  tabLabel: string;
  board: ProofBoardGuest[];
  guesses: ProofGuess[];
};
export type Proof = { runs: ProofRun[]; guessesTotal: number; alreadyOnShow: number };
export type Showcase = { runs: ShowcaseRun[]; proof: Proof };
export type ShowcaseResult = { ok: true; showcase: Showcase } | { ok: false };

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { next: { revalidate: 300 } });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

// "New Heights with Jason & Travis Kelce" becomes "New Heights".
function tabLabel(showName: string): string {
  return showName.replace(/ with .*$/, "");
}

export function formatRunDate(finishedAt: string): string {
  const date = new Date(finishedAt);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

// A run whose detail cannot be fetched or parsed, or whose flip is missing or
// not done, is left out of the proof. It still appears in the index.
async function loadProofRun(
  run: z.infer<typeof showcaseSchema>["runs"][number],
  base: string,
): Promise<ProofRun | null> {
  try {
    const detail = runDetailSchema.parse(await getJson(`${base}/runs/${run.runId}`));
    const flip = detail.withoutQloo;
    if (!flip || flip.status !== "done" || !flip.guesses) return null;
    return {
      runId: run.runId,
      position: run.position,
      showName: run.showName,
      tabLabel: tabLabel(run.showName),
      board: [...detail.board].sort((a, b) => a.fitRank - b.fitRank),
      guesses: flip.guesses,
    };
  } catch (error) {
    console.error(`Showcase run ${run.runId} left out of the proof`, error);
    return null;
  }
}

export async function loadShowcase(): Promise<ShowcaseResult> {
  const base = apiBase();
  try {
    const parsed = showcaseSchema.parse(await getJson(`${base}/showcase`));
    const runs = [...parsed.runs].sort((a, b) => a.position - b.position);
    const proofRuns = (await Promise.all(runs.map((run) => loadProofRun(run, base)))).filter(
      (run) => run !== null,
    );
    const guesses = proofRuns.flatMap((run) => run.guesses);
    return {
      ok: true,
      showcase: {
        runs: runs.map((run) => ({ ...run, runDate: formatRunDate(run.finishedAt) })),
        proof: {
          runs: proofRuns,
          guessesTotal: guesses.length,
          alreadyOnShow: guesses.filter((guess) => guess.pastGuest || guess.host).length,
        },
      },
    };
  } catch (error) {
    console.error("Showcase fetch failed", error);
    return { ok: false };
  }
}
