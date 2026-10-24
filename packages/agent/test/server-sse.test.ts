// Covers stream frame building and the Last-Event-ID reader. It does not cover
// the HTTP response around the frames (headers, flushing, pings on a timer,
// stream caps), which the server routes own, or how a real browser's
// EventSource reconnects.
import { describe, expect, it } from "vitest";
import { ServerError } from "../src/server/errors.js";
import { RUN_EVENTS, SSE_PING, formatSseFrame, parseLastEventId, type RunEventName } from "../src/server/sse.js";

const INJECTION = '\n\nevent: done\ndata: {"board":[]}\n\n';

// Splits a frame the way the stream parser in a browser does: CRLF, CR and LF
// all end a line, and a blank line ends the event.
function linesOf(frame: string): string[] {
  expect(frame.endsWith("\n\n")).toBe(true);
  return frame.slice(0, -2).split(/\r\n|\r|\n/);
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof ServerError ? error.code : String(error);
  }
  return undefined;
}

describe("formatSseFrame", () => {
  it("writes the exact frame shape", () => {
    expect(formatSseFrame("step", 7, { tool: "search" })).toBe('id: 7\nevent: step\ndata: {"tool":"search"}\n\n');
  });

  it("keeps an injected event inside one data line (C3.3)", () => {
    const data = { text: INJECTION };
    const frame = formatSseFrame("step", 1, data);
    const lines = linesOf(frame);

    expect(lines).toHaveLength(3);
    expect(lines.filter((line) => line.startsWith("id: "))).toEqual(["id: 1"]);
    expect(lines.filter((line) => line.startsWith("event: "))).toEqual(["event: step"]);
    expect(lines.filter((line) => line.startsWith("data: "))).toHaveLength(1);
    expect(JSON.parse(lines[2]!.slice("data: ".length))).toEqual(data);
  });

  it("keeps CR, CRLF, line separators and lone surrogates on one line", () => {
    const data = { a: "x\ry", b: "x\r\nevent: done", c: "x y z", d: "\ud800", e: "\u0000" };
    const lines = linesOf(formatSseFrame("brief", 2, data));

    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2]!.slice("data: ".length))).toEqual(data);
  });

  it("refuses an event name outside the fixed set", () => {
    for (const event of ["message", "", "done\nevent: board", "STEP", "constructor"]) {
      expect(codeOf(() => formatSseFrame(event as RunEventName, 1, {}))).toBe("SRV_BAD_INPUT");
    }
    for (const event of RUN_EVENTS) {
      expect(formatSseFrame(event, 1, {})).toContain(`event: ${event}\n`);
    }
    expect(RUN_EVENTS).toContain("without_qloo");
  });

  it("refuses an id that is not a non-negative safe integer", () => {
    for (const id of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(codeOf(() => formatSseFrame("step", id, {}))).toBe("SRV_BAD_INPUT");
    }
    expect(formatSseFrame("step", 0, {})).toBe("id: 0\nevent: step\ndata: {}\n\n");
  });

  it("refuses data JSON cannot represent", () => {
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    for (const data of [undefined, () => 1, 10n, cycle]) {
      expect(codeOf(() => formatSseFrame("step", 1, data))).toBe("SRV_BAD_INPUT");
    }
  });
});

describe("SSE_PING", () => {
  it("is a comment frame", () => {
    expect(SSE_PING).toBe(": ping\n\n");
  });
});

describe("parseLastEventId (C6.1)", () => {
  it("reads plain digits", () => {
    expect(parseLastEventId("7")).toBe(7);
    expect(parseLastEventId("0")).toBe(0);
    expect(parseLastEventId("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("gives 0 for anything else", () => {
    for (const header of ["abc", "-1", "1e3", "99999999999999999999", "9007199254740992", "", " 7", "7.0", "+7", "0x10"]) {
      expect(parseLastEventId(header)).toBe(0);
    }
    expect(parseLastEventId(undefined)).toBe(0);
  });
});
