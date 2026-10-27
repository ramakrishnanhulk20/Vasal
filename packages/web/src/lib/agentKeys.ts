import { z } from "zod";
import { call } from "@/lib/api";
import type { Result } from "@/lib/api";
import { apiBase } from "@/lib/run";

const limitsSchema = z.object({
  runsPerDay: z.number(),
  findsPerDay: z.number(),
  briefsPerDay: z.number(),
  inflightPerKey: z.number(),
  keyLifeDays: z.number(),
  keysPerVisitorPerDay: z.number(),
});

const deskSchema = z.object({ open: z.boolean(), limits: limitsSchema });

const issuedSchema = z.object({
  token: z.string().min(1),
  expiresAt: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
});

export type KeyLimits = z.infer<typeof limitsSchema>;
export type KeyDeskState = z.infer<typeof deskSchema>;
export type IssuedKey = z.infer<typeof issuedSchema>;

// Read on the server for the page. Null means unknown: the page then shows no
// limits and keeps the form, and the POST answers for itself.
export async function loadKeyDesk(): Promise<KeyDeskState | null> {
  try {
    const response = await fetch(`${apiBase()}/agent-keys`, { next: { revalidate: 30 } });
    if (!response.ok) {
      console.error(`Agent key settings fetch failed with status ${response.status}`);
      return null;
    }
    const parsed = deskSchema.safeParse(await response.json());
    if (!parsed.success) {
      console.error("Agent key settings did not match the expected shape", parsed.error.message);
      return null;
    }
    return parsed.data;
  } catch (error) {
    console.error("Agent key settings fetch threw", error);
    return null;
  }
}

// The browser asks for a key with the answer from the human check. The key
// comes back in this one response and is never logged or stored.
export function issueAgentKey(turnstileToken: string): Promise<Result<IssuedKey>> {
  return call(
    "/agent-keys",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turnstileToken }),
    },
    issuedSchema,
  );
}
