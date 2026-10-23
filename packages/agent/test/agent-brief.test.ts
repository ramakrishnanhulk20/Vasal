// Covers writing a brief with a scripted fake model: the facts the model is
// given, each draft's fixed time limit, the one rewrite after failed prose,
// removal of links and emails, placeholders filled with code values, the
// reach phrase, and the trend-claim refusal for a guest with no trend data. It
// does not cover checkProse's own rules (agent-prose), how the client
// enforces the limit (agent-model), the real model's writing, or storing the
// brief (agent-runner). All data is synthetic.
import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import type { BoardEntry } from "../src/agent/board.js";
import { writeBrief } from "../src/agent/brief.js";
import { AgentError } from "../src/agent/errors.js";
import type { ModelCallOptions, ModelClient } from "../src/agent/model.js";
import { BRIEF_SYSTEM } from "../src/agent/prompts.js";
import { TREND_CLAIM_WORDS } from "../src/agent/prose.js";

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

const UNKNOWN_RISING: BoardEntry = { ...GUEST, rising: { state: "unknown", points: null } };

type StructuredParams = Parameters<ModelClient["structured"]>[0];
type Fact = { placeholder: string; meaning: string; value?: string };

const factsOf = (user: string) => JSON.parse(user.slice(user.indexOf("\n") + 1)) as Record<string, Fact>;

// Mirrors the real client's contract: a reply that fails the schema is AGENT_BAD_PROSE.
function fakeModel(drafts: unknown[]) {
  const calls: StructuredParams[] = [];
  const options: Array<ModelCallOptions | undefined> = [];
  const model: ModelClient = {
    async turn() {
      throw new Error("turn is not used for briefs");
    },
    async structured<T>(
      params: { system: string; user: string; schema: ZodType<T>; maxTokens: number },
      callOptions?: ModelCallOptions,
    ): Promise<T> {
      calls.push(params as StructuredParams);
      options.push(callOptions);
      const next = drafts[calls.length - 1];
      if (next instanceof Error) throw next;
      const parsed = params.schema.safeParse(next);
      if (!parsed.success) throw new AgentError("AGENT_BAD_PROSE");
      return parsed.data;
    },
  };
  return { model, calls, options };
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

  it("gives every draft a fixed 45 second time limit and passes MODEL_TIMEOUT straight through (C2.4)", async () => {
    const retried = fakeModel([{ ...GOOD, questions: ["Q?"] }, GOOD]);
    await writeBrief(retried.model, { guest: GUEST, showName: SHOW_NAME });
    expect(retried.options).toEqual([{ timeoutMs: 45_000 }, { timeoutMs: 45_000 }]);

    const slow = fakeModel([new AgentError("MODEL_TIMEOUT")]);
    expect(await codeOf(writeBrief(slow.model, { guest: GUEST, showName: SHOW_NAME }))).toBe("MODEL_TIMEOUT");
    expect(slow.calls).toHaveLength(1);
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

describe("writeBrief wording", () => {
  it("fills {{reach}} with a whole sentence naming the guest, and shows the model the same sentence", async () => {
    const sentences: Array<[BoardEntry["reach"], string]> = [
      ["bookable", "is within reach, so booking is realistic"],
      ["well known", "is well known, so booking will take some work"],
      ["household name", "is a household name, so booking will be a long shot"],
    ];
    for (const [reach, rest] of sentences) {
      const { model, calls } = fakeModel([{ ...GOOD, why: "{{guest}} suits {{show}}. {{reach}}." }]);

      const { brief } = await writeBrief(model, { guest: { ...GUEST, reach }, showName: SHOW_NAME });

      expect(brief.why).toBe(`Blink-182 suits Synthetic Show. Blink-182 ${rest}.`);
      expect(factsOf(calls[0]!.user)["reach"]).toMatchObject({ placeholder: "{{reach}}", value: `{{guest}} ${rest}` });
    }
  });

  it("keeps the host's notes out of the pitch: {{reach}} or {{brings}} in the subject or email fails, while why may use both", async () => {
    for (const field of ["pitch_subject", "pitch_body"] as const) {
      for (const note of ["{{reach}}.", "{{brings}}"]) {
        const draft = { ...GOOD, [field]: `Hi team. ${note}` };
        const { model, calls } = fakeModel([draft, draft]);
        expect(await codeOf(writeBrief(model, { guest: GUEST, showName: SHOW_NAME })), `${field} ${note}`).toBe("AGENT_BAD_PROSE");
        expect(calls).toHaveLength(2);
      }
    }
    const { model } = fakeModel([{ ...GOOD, why: "{{reach}}. It would also bring {{brings}}." }]);
    expect((await writeBrief(model, { guest: GUEST, showName: SHOW_NAME })).brief.why).toContain("so booking will take some work.");
  });

  it("gives the model the board's angle as the episode idea, cleaned and capped, and leaves it out when empty", async () => {
    const withIdea = fakeModel([GOOD]);
    await writeBrief(withIdea.model, { guest: GUEST, showName: SHOW_NAME });
    expect(factsOf(withIdea.calls[0]!.user)["episodeIdea"]).toEqual({
      meaning: "the episode idea picked for this guest when the board was built: base the angle and every question on it",
      value: GUEST.angle,
    });
    expect(BRIEF_SYSTEM).toContain("Base the angle and every question on the episode idea");

    const long = fakeModel([GOOD]);
    await writeBrief(long.model, { guest: { ...GUEST, angle: `  A ${"very ".repeat(120)}long​ idea  ` }, showName: SHOW_NAME });
    const idea = (factsOf(long.calls[0]!.user)["episodeIdea"] as unknown as { value: string }).value;
    expect([...idea].length).toBeLessThanOrEqual(400);
    expect(idea.startsWith("A very")).toBe(true);
    expect(idea).not.toContain("​");

    const none = fakeModel([GOOD]);
    await writeBrief(none.model, { guest: { ...GUEST, angle: "   " }, showName: SHOW_NAME });
    expect(factsOf(none.calls[0]!.user)).not.toHaveProperty("episodeIdea");
  });

  it("describes a shared tag to the model as a word for both audiences, not a thing", async () => {
    const { model, calls } = fakeModel([GOOD]);
    await writeBrief(model, { guest: GUEST, showName: SHOW_NAME });
    const tastes = factsOf(calls[0]!.user)["sharedTastes"] as unknown as Array<{ meaning: string }>;
    expect(tastes[0]!.meaning).toContain("a word Qloo uses to describe both audiences");
  });

  it("refuses a draft that wraps {{reach}} in other words, so the clumsy wording from the first real run cannot come back", async () => {
    for (const why of ["Booking {{guest}} is {{reach}}.", "{{guest}} is {{reach}}.", "{{reach}} and worth it.", "Good news, {{reach}}."]) {
      const { model, calls } = fakeModel([{ ...GOOD, why }, { ...GOOD, why }]);
      expect(await codeOf(writeBrief(model, { guest: GUEST, showName: SHOW_NAME })), why).toBe("AGENT_BAD_PROSE");
      expect(calls).toHaveLength(2);
    }
    const { model } = fakeModel([{ ...GOOD, why: "{{reach}}.\nIt is a good match." }]);
    expect((await writeBrief(model, { guest: GUEST, showName: SHOW_NAME })).brief.why).toBe(
      "Blink-182 is well known, so booking will take some work.\nIt is a good match.",
    );
  });

  it("gives an unknown-rising guest's rising fact no value, and tells the model not to call a guest rising without one", async () => {
    const { model, calls } = fakeModel([GOOD]);

    await writeBrief(model, { guest: UNKNOWN_RISING, showName: SHOW_NAME });

    expect(factsOf(calls[0]!.user)["rising"]).toEqual({ placeholder: "{{rising}}", meaning: "no trend data exists for this guest, so do not use it" });
    expect(BRIEF_SYSTEM).toContain(`Never describe the guest as ${TREND_CLAIM_WORDS} unless the rising fact has a value.`);
  });

  it("refuses a draft calling an unknown-rising guest rising, and keeps a clean rewrite", async () => {
    const rising = { ...GOOD, why: "{{guest}} is a rising voice {{show}} listeners will love." };

    const refused = fakeModel([rising, rising]);
    expect(await codeOf(writeBrief(refused.model, { guest: UNKNOWN_RISING, showName: SHOW_NAME }))).toBe("AGENT_BAD_PROSE");
    expect(refused.calls).toHaveLength(2);

    const rewritten = fakeModel([{ ...GOOD, pitch_body: "We think {{guest}} is on the rise. Could we find a date?" }, GOOD]);
    const { brief } = await writeBrief(rewritten.model, { guest: UNKNOWN_RISING, showName: SHOW_NAME });
    expect(rewritten.calls).toHaveLength(2);
    expect(brief.why).toBe("Blink-182 has 86% fit with Synthetic Show listeners, and interest is not yet tracked.");
  });

  it("checks before filling, so a shared tag named like a trend never trips the refusal", async () => {
    const { model } = fakeModel([GOOD]);

    const { brief } = await writeBrief(model, { guest: { ...UNKNOWN_RISING, sharedTags: ["Rising Stars", "skate culture"] }, showName: SHOW_NAME });

    expect(brief.angle).toBe("Growing up loud with Rising Stars.");
  });

  it("refuses calling a steady or falling guest rising, since their trend says otherwise", async () => {
    const rising = { ...GOOD, why: "{{guest}} is a rising voice {{show}} listeners will love." };
    for (const state of ["steady", "falling"] as const) {
      const { model, calls } = fakeModel([rising, rising]);
      expect(await codeOf(writeBrief(model, { guest: { ...GUEST, rising: { state, points: 0.1 } }, showName: SHOW_NAME })), state).toBe(
        "AGENT_BAD_PROSE",
      );
      expect(calls).toHaveLength(2);
    }
  });

  it("still lets a guest whose trend is rising be called rising", async () => {
    const { model, calls } = fakeModel([{ ...GOOD, why: "{{guest}} is a rising voice {{show}} listeners will love." }]);

    const { brief } = await writeBrief(model, { guest: GUEST, showName: SHOW_NAME });

    expect(calls).toHaveLength(1);
    expect(brief.why).toBe("Blink-182 is a rising voice Synthetic Show listeners will love.");
  });
});
