import type { Db } from "../store/db.js";
import { appendEvent, markBriefFailed, setRunStatus, type RunInput } from "./runs.js";

/**
 * What the routes ask of the agent. The routes call each method after every
 * check and cap has passed, and never pass anything the client sent except
 * the checked run input and server-issued ids. The website routes do not await
 * it; the MCP door awaits startRun and polls the store for the others. While a
 * website startRun is unsettled the run holds one site-wide in-progress slot;
 * an MCP startRun and an MCP continueRun each hold the slot pair, one MCP slot
 * and one site slot taken together (acquireMcpRunSlots), and an MCP startRun
 * also holds its key's in-flight slot, as every MCP request does. If startRun
 * or continueRun rejects, the route marks the run failed with AGENT_ERROR
 * unless the agent already finished it, so an agent that wants a more
 * specific code must set it before rejecting. writeBrief must leave the
 * guest's brief claim done or failed, never pending, because the page waits
 * on it; a writeBrief rejection is only logged.
 */
export type AgentPort = {
  /**
   * False only for the unavailable agent. When it is false the brief routes
   * refuse before claiming, so a server with no keys never spends a guest's
   * attempts. Every other agent leaves it out, and absent means ready.
   */
  ready?: boolean;
  startRun(runId: string, input: RunInput): Promise<void>;
  continueRun(runId: string, candidateId: string): Promise<void>;
  writeBrief(runId: string, guestId: string): Promise<void>;
};

const AGENT_NOT_READY = "AGENT_NOT_READY";

/**
 * The agent the server runs until the real agent loop exists. startRun and
 * continueRun make no upstream call: they mark the run failed with
 * AGENT_NOT_READY and append a "failed" event { code: "AGENT_NOT_READY" },
 * which is the honest answer, never a made-up result. writeBrief stores
 * nothing and marks the guest's pending brief claim failed with
 * AGENT_NOT_READY, so the page shows that failure instead of waiting. Its
 * ready is false, so the brief routes refuse with AGENT_NOT_READY before
 * they claim, and writeBrief runs only for a caller that skips that check.
 * startRun and continueRun reject with the run store's ServerError if the
 * run is unknown or already finished, or the database fails; writeBrief
 * rejects with it for a bad id or a database failure.
 */
export function createUnavailableAgent(db: Db): AgentPort {
  const refuse = async (runId: string): Promise<void> => {
    await setRunStatus(db, runId, "failed", AGENT_NOT_READY);
    await appendEvent(db, runId, "failed", { code: AGENT_NOT_READY });
  };
  return {
    ready: false,
    startRun: (runId) => refuse(runId),
    continueRun: (runId) => refuse(runId),
    writeBrief: async (runId, guestId) => {
      await markBriefFailed(db, runId, guestId, AGENT_NOT_READY);
    },
  };
}
