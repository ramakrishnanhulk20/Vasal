// Covers writing a brief with a scripted fake model: the facts the model is
// given, the one rewrite after failed prose, removal of links and emails,
// and placeholders filled with code values. It does not cover checkProse's
// own rules (agent-prose), the real model's writing, or storing the brief
// (agent-runner). All data is synthetic.
import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import type { BoardEntry } from "../src/agent/board.js";
import { writeBrief } from "../src/agent/brief.js";
import { AgentError } from "../src/agent/errors.js";
import type { ModelClient } from "../src/agent/model.js";
import { BRIEF_SYSTEM } from "../src/agent/prompts.js";

const SHOW_NAME = "Synthetic Show";
const GUEST: BoardEntry = {
  personId: "00000000-0000-4000-8000-000000000201",
  name: "Blink-182",
  fit: 0.86,
  fitKnown: true,
  fitRank: 1,
  reach: "well known",
  rising: { state: "rising", points: 3.2 },
  bringsNew: { segment: "age:25_to_29", label: "listeners 25 to 29", gap: 0.4 },
  sharedTags: ["pop punk", "skate culture", "90s nostalgia"],
  angle: "Growing up loud.",
};

const GOOD = {
  why: "{{guest}} has {{fit}} with {{show}} listeners, and interest is {{rising}}.",
  angle: "Growing up loud with {{tag1}}.",
  questions: ["What drew you to {{tag2}}?", "What changed?", "What stayed?", "Who inspired you?", "Why do {{brings}} love you?"],
  pitch_subject: "{{show}} would love to have {{guest}}",
  pitch_body: "Hi team, we would love {{guest}} on {{show}}. Could we find a date that works?",
};

type StructuredParams = Parameters<ModelClient["structured"]>[0];

// Mirrors the real client's contract: a reply that fails the schema is AGENT_BAD_PROSE.
function fakeModel(drafts: unknown[]) {
  const calls: StructuredParams[] = [];
  const model: ModelClient = {
    async turn() {
      throw new Error("turn is not used for briefs");
    },
    async structured<T>(params: { system: string; user: string; schema: ZodType<T>; maxTokens: number }): Promise<T> {
      calls.push(params as StructuredParams);
      const next = drafts[calls.length - 1];
      if (next instanceof Error) throw next;
      const parsed = params.schema.safeParse(next);
      if (!parsed.success) throw new AgentError("AGENT_BAD_PROSE");
      return parsed.data;
    },
  };
  return { model, calls };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof AgentError ? error.code : String(error);
  }
  return "resolved";
}

describe("writeBrief", () => {
  it("gives the model placeholders and words only, then fills them with code values", async () => {
    const { model, calls } = fakeModel([GOOD]);

    const { brief, removed } = await writeBrief(model, { guest: GUEST, showName: SHOW_NAME });

    expect(brief).toEqual({
      why: "Blink-182 has 86% fit with Synthetic Show listeners, and interest is on the rise.",
      angle: "Growing up loud with pop punk.",
      questions: ["What drew you to skate culture?", "What changed?", "What stayed?", "Who inspired you?", "Why do listeners 25 to 29 love you?"],
      pitch_subject: "Synthetic Show would love to have Blink-182",
      pitch_body: "Hi team, we would love Blink-182 on Synthetic Show. Could we find a date that works?",
    });
    expect(removed).toEqual({ links: 0, emails: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).toBe(BRIEF_SYSTEM);
    expect(calls[0]!.maxTokens).toBe(4000);
    const facts = calls[0]!.user;
    expect(facts).not.toContain("Blink-182");
    expect(facts).not.toContain(SHOW_NAME);
    expect(facts).not.toContain("0.86");
    for (const token of ["{{guest}}", "{{show}}", "{{fit}}", "{{reach}}", "{{rising}}", "{{brings}}", "{{tag1}}", "{{tag3}}"]) {
      expect(facts).toContain(token);
    }
    expect(facts).not.toContain("{{tag4}}");
  });

  it("rewrites a draft with a typed figure once, then fails with AGENT_BAD_PROSE (C3.4)", async () => {
    const bad = { ...GOOD, why: "{{guest}} scores fit 9.7/10 with 2M listeners." };
    const { model, calls } = fakeModel([bad, bad]);

    expect(await codeOf(writeBrief(model, { guest: GUEST, showName: SHOW_NAME }))).toBe("AGENT_BAD_PROSE");
    expect(calls).toHaveLength(2);
  });

  it("keeps the second draft when only the first fails", async () => {
    const { model, calls } = fakeModel([{ ...GOOD, questions: ["Q?", "Q?", "Q?", "Q?"] }, GOOD]);

    const { brief } = await writeBrief(model, { guest: GUEST, showName: SHOW_NAME });

    expect(calls).toHaveLength(2);
    expect(brief.angle).toBe("Growing up loud with pop punk.");
  });

  it("removes links and emails and counts them (C3.5)", async () => {
    const { model } = fakeModel([
      {
        ...GOOD,
        why: "{{guest}} fits {{show}}. See https://evil.example for more.",
        pitch_body: "Write to bob@evil.example or log in at evil.example/login to book {{guest}}.",
      },
    ]);

    const { brief, removed } = await writeBrief(model, { guest: GUEST, showName: SHOW_NAME });

    expect(removed).toEqual({ links: 2, emails: 1 });
    const all = JSON.stringify(brief);
    for (const gone of ["https://evil.example", "evil.example/login", "bob@evil.example", "evil.example"]) expect(all).not.toContain(gone);
    expect(brief.why).toBe("Blink-182 fits Synthetic Show. See for more.");
  });

  it("lets a name with digits reach the output only through {{guest}}", async () => {
    const typed = { ...GOOD, pitch_subject: "Blink-182 on Synthetic Show" };
    const { model, calls } = fakeModel([typed, typed]);

    expect(await codeOf(writeBrief(model, { guest: GUEST, showName: SHOW_NAME }))).toBe("AGENT_BAD_PROSE");
    expect(calls).toHaveLength(2);
  });

  it("refuses a tag placeholder with no tag behind it and an unknown placeholder", async () => {
    for (const why of ["{{guest}} loves {{tag4}}.", "{{guest}} is {{name}}."]) {
      const { model, calls } = fakeModel([{ ...GOOD, why }, { ...GOOD, why }]);
      expect(await codeOf(writeBrief(model, { guest: GUEST, showName: SHOW_NAME }))).toBe("AGENT_BAD_PROSE");
      expect(calls).toHaveLength(2);
    }
  });

  it("says plainly when the fit is unscored and passes other model errors straight through", async () => {
    const unscored = fakeModel([{ ...GOOD, angle: "Growing up loud.", questions: ["One?", "Two?", "Three?", "Four?", "Five?"] }]);
    const { brief } = await writeBrief(unscored.model, {
      guest: { ...GUEST, fit: 0, fitKnown: false, bringsNew: null, sharedTags: [] },
      showName: SHOW_NAME,
    });
    expect(brief.why).toBe("Blink-182 has an unscored fit with Synthetic Show listeners, and interest is on the rise.");

    const budget = fakeModel([new AgentError("MODEL_BUDGET")]);
    expect(await codeOf(writeBrief(budget.model, { guest: GUEST, showName: SHOW_NAME }))).toBe("MODEL_BUDGET");
    expect(budget.calls).toHaveLength(1);
  });
});
