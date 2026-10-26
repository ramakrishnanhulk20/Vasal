import { z } from "zod";
import { apiBase } from "@/lib/run";

const healthSchema = z.object({ ok: z.boolean(), liveRuns: z.boolean().optional() });

// True only when the server says it is healthy and open for live runs. A failed
// fetch or an unexpected answer counts as closed.
export async function loadLiveRuns(): Promise<boolean> {
  try {
    const response = await fetch(`${apiBase()}/health`, { next: { revalidate: 30 } });
    if (!response.ok) return false;
    const health = healthSchema.parse(await response.json());
    return health.ok && health.liveRuns === true;
  } catch (error) {
    console.error("Health check failed, treating live runs as closed", error);
    return false;
  }
}
