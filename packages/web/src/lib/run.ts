import { z } from "zod";

const RUN_ID = "915764d5-a8d9-4249-8f1b-9e779ceff2ea";
const DEFAULT_API_URL = "https://api.vasal.site";

const boardGuest = z.object({
  id: z.string(),
  name: z.string(),
  fit: z.number(),
  fitKnown: z.boolean(),
  fitRank: z.number(),
  bringsNew: z.string().nullable(),
  sharedTags: z.array(z.string()),
  angle: z.string(),
});

const kolam = z.object({
  version: z.literal(1),
  viewBox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  dots: z.array(
    z.object({ x: z.number(), y: z.number(), guestId: z.string(), tagIndex: z.number() }),
  ),
  rings: z.array(
    z.object({
      guestId: z.string(),
      points: z.array(z.tuple([z.number(), z.number()])),
      d: z.string(),
    }),
  ),
  joined: z.array(z.object({ guestId: z.string(), d: z.string() })),
});

export { boardGuest as boardGuestSchema, kolam as kolamSchema };

const runSchema = z.object({
  board: z.array(boardGuest),
  kolam,
  pastGuests: z.object({
    feedName: z.string().nullable(),
    episodes: z.number(),
    archiveTitles: z.number(),
    since: z.string().nullable(),
  }),
});

export type BoardGuest = z.infer<typeof boardGuest>;
export type KolamData = z.infer<typeof kolam>;
export type Run = z.infer<typeof runSchema>;
export type RunResult = { ok: true; run: Run } | { ok: false };

// Every drawn guest must be on the board, because the stroke width and the
// hover label are read from the board entry.
function drawnGuestsAreOnBoard(run: Run): boolean {
  const ids = new Set(run.board.map((guest) => guest.id));
  return [...run.kolam.dots, ...run.kolam.rings, ...run.kolam.joined].every((item) =>
    ids.has(item.guestId),
  );
}

export function apiBase(): string {
  return (process.env.VASAL_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
}

export async function loadRun(): Promise<RunResult> {
  const base = apiBase();
  try {
    const response = await fetch(`${base}/runs/${RUN_ID}`, { next: { revalidate: 300 } });
    if (!response.ok) {
      console.error(`Run fetch failed with status ${response.status}`);
      return { ok: false };
    }
    const parsed = runSchema.safeParse(await response.json());
    if (!parsed.success) {
      console.error("Run response did not match the expected shape", parsed.error.message);
      return { ok: false };
    }
    if (!drawnGuestsAreOnBoard(parsed.data)) {
      console.error("Run response draws a guest that is not on the board");
      return { ok: false };
    }
    return { ok: true, run: parsed.data };
  } catch (error) {
    console.error("Run fetch threw", error);
    return { ok: false };
  }
}
