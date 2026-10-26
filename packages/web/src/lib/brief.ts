import { z } from "zod";

export const briefContentSchema = z.object({
  why: z.string(),
  angle: z.string(),
  questions: z.array(z.string()),
  pitchSubject: z.string(),
  pitchBody: z.string(),
});

export const briefSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("done"), brief: briefContentSchema }),
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("none") }),
  z.object({ status: z.literal("failed"), code: z.string().nullish() }),
]);

export type BriefContent = z.infer<typeof briefContentSchema>;
export type BriefState = z.infer<typeof briefSchema>;
