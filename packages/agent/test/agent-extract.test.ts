// Covers the backtest's guest extractor with a fake model that applies the
// schema the way the real client does. It does not cover how well a real
// model reads titles, or the name-in-title check the backtest applies after
// it (backtest-eligibility, backtest-pipeline).
import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { AgentError } from "../src/agent/errors.js";
import { createGuestExtractor } from "../src/agent/extract-guest.js";
import type { ModelClient } from "../src/agent/model.js";
import { EXTRACT_SYSTEM } from "../src/agent/prompts.js";

type StructuredParams = { system: string; user: string; schema: ZodType<unknown>; maxTokens: number };

function fakeModel(answer: unknown) {
  const calls: StructuredParams[] = [];
  const model: ModelClient = {
    async turn() {
      throw new Error("turn is not used by the extractor");
    },
    async structured<T>(params: { system: string; user: string; schema: ZodType<T>; maxTokens: number }): Promise<T> {
      calls.push(params as StructuredParams);
      const parsed = params.schema.safeParse(answer);
      if (!parsed.success) throw new AgentError("AGENT_BAD_PROSE");
      return parsed.data;
    },
  };
  return { extract: createGuestExtractor(model), calls };
}

describe("createGuestExtractor", () => {
  it("returns the one guest a title names, trimmed, sending the title as the user text with 1,024 max tokens", async () => {
    const { extract, calls } = fakeModel({ kind: "one", name: " Michael Douglas " });

    expect(await extract("#2040 - Michael Douglas")).toEqual({ kind: "one", name: "Michael Douglas" });
    expect(calls).toEqual([{ system: EXTRACT_SYSTEM, user: "#2040 - Michael Douglas", schema: calls[0]!.schema, maxTokens: 1_024 }]);
  });

  it("passes several and none through, ignoring any name sent with them", async () => {
    expect(await fakeModel({ kind: "several", name: "A and B" }).extract("A and B")).toEqual({ kind: "several" });
    expect(await fakeModel({ kind: "none", name: null }).extract("Best of the year")).toEqual({ kind: "none" });
  });

  it("treats one with a null, empty or blank name as none", async () => {
    for (const name of [null, "", "   "]) {
      expect(await fakeModel({ kind: "one", name }).extract("Synthetic Whistleblower: a warning")).toEqual({ kind: "none" });
    }
  });

  it("refuses a too long name, an unknown kind and an extra field", async () => {
    for (const answer of [
      { kind: "one", name: "x".repeat(101) },
      { kind: "maybe", name: "Dax" },
      { kind: "one", name: "Dax", extra: true },
    ]) {
      await expect(fakeModel(answer).extract("#1 - Dax")).rejects.toMatchObject({ code: "AGENT_BAD_PROSE" });
    }
  });
});
