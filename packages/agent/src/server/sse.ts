import { ServerError } from "./errors.js";

/**
 * The fixed set of stream event names (C3.3). runs.ts re-exports it, and both
 * the stored events and the stream frames are checked against this one list.
 * A stored event streams as stored except for reach, which goes out as
 * publicReach gives it, so each one holds only what the page may show;
 * "without_qloo" holds Qloo names, numbers and flags, never an id or model
 * text (D5.5).
 */
export const RUN_EVENTS = ["step", "candidates", "board", "brief", "without_qloo", "done", "failed"] as const;
export type RunEventName = (typeof RUN_EVENTS)[number];

/** A comment frame. EventSource ignores it, and it keeps idle proxies from closing the stream. */
export const SSE_PING = ": ping\n\n";

// Sixteen digits covers every safe integer. Longer input is refused before
// Number() can round it to something else.
const LAST_EVENT_ID = /^[0-9]{1,16}$/;

const badInput = (): ServerError => new ServerError("SRV_BAD_INPUT");

/**
 * Builds one server-sent event frame: `id: <id>\nevent: <event>\ndata: <json>\n\n`.
 * `data` is written only as JSON.stringify output, which escapes CR and LF
 * inside strings, so no upstream text can start a new line or a new event
 * (C3.3). Throws ServerError("SRV_BAD_INPUT") for an event name outside
 * RUN_EVENTS, an id that is not a non-negative safe integer, or data that
 * JSON cannot represent (undefined, a function, a BigInt, a cycle).
 */
export function formatSseFrame(event: RunEventName, id: number, data: unknown): string {
  if (typeof event !== "string" || !(RUN_EVENTS as readonly string[]).includes(event)) throw badInput();
  if (!Number.isSafeInteger(id) || id < 0) throw badInput();

  let json: string | undefined;
  try {
    json = JSON.stringify(data);
  } catch {
    throw badInput();
  }
  // The stream parser ends a line at CR, LF or CRLF. JSON.stringify never
  // emits either outside an escape, and this refuses instead of trusting that.
  if (typeof json !== "string" || /[\r\n]/.test(json)) throw badInput();

  return `id: ${id}\nevent: ${event}\ndata: ${json}\n\n`;
}

/**
 * Reads the Last-Event-ID header a reconnecting EventSource sends. Returns
 * the value when it is plain decimal digits forming a safe integer, and 0 for
 * anything else (missing, empty, signed, exponent, fractional, too large), so
 * a bad header replays from the start instead of failing (C6.1). Never throws.
 */
export function parseLastEventId(header: string | undefined): number {
  if (typeof header !== "string" || !LAST_EVENT_ID.test(header)) return 0;
  const value = Number(header);
  return Number.isSafeInteger(value) ? value : 0;
}
