// Covers runToExit, the wrapper that ends every ops command, with a stub exit
// and a short limit. It does not end a real process; the ops self-test run
// from the command line shows that.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runToExit } from "../scripts/ops.js";

const MARKER = "MARKER-5e0a";

let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errors.mockRestore();
});

function exitSpy(): { exit: (code: number) => void; codes: number[]; first: Promise<number> } {
  const codes: number[] = [];
  let resolve: (code: number) => void = () => {};
  const first = new Promise<number>((done) => {
    resolve = done;
  });
  return {
    codes,
    first,
    exit: (code) => {
      codes.push(code);
      resolve(code);
    },
  };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("runToExit", () => {
  it("exits once with the code the command returns, and the timer never fires after", async () => {
    const spy = exitSpy();
    await runToExit(async () => 3, { limitMs: 30, exit: spy.exit });

    expect(await spy.first).toBe(3);
    await pause(80);
    expect(spy.codes).toEqual([3]);
    expect(errors).not.toHaveBeenCalled();
  });

  it("exits 1 with one fixed line when the command throws", async () => {
    const spy = exitSpy();
    await runToExit(() => Promise.reject(new Error(`postgresql://u:${MARKER}@db.example`)), { limitMs: 1_000, exit: spy.exit });

    expect(await spy.first).toBe(1);
    expect(errors.mock.calls).toEqual([[JSON.stringify({ level: "error", route: "ops", code: "UNEXPECTED" })]]);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(MARKER);
  });

  it("exits 1 with OPS_TIMEOUT when the command never settles", async () => {
    const spy = exitSpy();
    void runToExit(() => new Promise<number>(() => {}), { limitMs: 25, exit: spy.exit });

    expect(await spy.first).toBe(1);
    expect(spy.codes).toEqual([1]);
    expect(errors.mock.calls).toEqual([['{"level":"error","route":"ops","code":"OPS_TIMEOUT"}']]);
  });

  it("does not exit twice when a command settles after its timeout", async () => {
    const spy = exitSpy();
    void runToExit(
      async () => {
        await pause(60);
        return 0;
      },
      { limitMs: 20, exit: spy.exit },
    );

    expect(await spy.first).toBe(1);
    await pause(100);
    expect(spy.codes).toEqual([1]);
  });
});
