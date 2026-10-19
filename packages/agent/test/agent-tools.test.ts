// Covers the research tools against a fake metered Qloo: the fixed tool list,
// every refusal that must happen before any Qloo call, the request each tool
// builds, size caps on what goes back to the model, and step summaries that
// carry no ids or upstream text. It does not cover the model loop or the
// Anthropic client (next work order), the real cache and meter (see
// qloo-metered.test.ts), or real Qloo response shapes. All data is synthetic.
import { describe, expect, it } from "vitest";
import { createRunContext, type RunContext } from "../src/agent/context.js";
import { researchTools, runTool, TOOL_LIMITS, type ToolName } from "../src/agent/tools.js";
import { QlooError } from "../src/qloo/errors.js";
import type { MeteredQloo } from "../src/qloo/metered.js";
import type { QlooOperation } from "../src/qloo/request.js";

const MARKER = "MARKER-5d1c";
const TODAY = new Date("2026-10-19T09:30:00.000Z");
const SHOW = { qlooId: "00000000-0000-4000-8000-000000000001", name: `Synthetic Show ${MARKER}` };
const personId = (n: number) => `00000000-0000-4000-8000-0000000002${String(n).padStart(2, "0")}`;
const NEVER_RETURNED = "00000000-0000-4000-8000-000000000999";

const synthPeople = (count: number) =>
  Array.from({ length: count }, (_, n) => ({
    entity_id: personId(n + 1),
    name: `Synthetic Person ${n + 1} ${MARKER}`,
    popularity: 0.5 + n / 100,
    query: { affinity: 0.987 - n / 100 },
  }));

function synthResponse(op: QlooOperation): unknown {
  switch (op.op) {
    case "insights":
      return op.filterType === "urn:entity:person"
        ? synthPeople(3)
        : [1, 2].map((n) => ({ entity_id: `00000000-0000-4000-8000-00000000030${n}`, name: `Synthetic Title ${n} ${MARKER}` }));
    case "demographics":
      return [
        {
          entity_id: op.signalEntities[0],
          query: { age: { "25_to_29": 0.4, "30_to_34": -0.1, "55_and_older": 0.2 }, gender: { female: 0.3, male: -0.3 } },
        },
      ];
    case "trending":
      return Array.from({ length: 12 }, (_, week) => ({
        date: new Date(Date.UTC(2026, 9, 18) - week * 7 * 86_400_000).toISOString().slice(0, 10),
        population_percentile: week < 4 ? 70 : 60,
      }));
    case "compare":
      return [0.9, 0.2, 0.7].map((score, n) => ({ tag_id: `urn:tag:synthetic:${n}`, name: `taste ${n} ${MARKER}`, query: { score } }));
    case "search":
      return [{ entity_id: personId(50), name: `Synthetic Found ${MARKER}`, popularity: 0.3, query: { affinity: 0.99 } }];
    case "tags":
      return [];
  }
}

function fakeQloo(respond: (op: QlooOperation) => unknown = synthResponse) {
  const ops: QlooOperation[] = [];
  const qloo: MeteredQloo = {
    async call<T>(op: QlooOperation): Promise<{ data: T; fromCache: boolean }> {
      ops.push(op);
      return { data: respond(op) as T, fromCache: false };
    },
    stats: () => ({ calls: ops.length, cacheHits: 0 }),
  };
  return { qloo, ops };
}

const newContext = (episodeTitles: string[] = []): RunContext =>
  createRunContext({ show: SHOW, episodeTitles, exclusions: [] });

const errorOf = (content: string) => JSON.parse(content) as { error: string };

const VALID_PICKS = [1, 2, 3].map((n) => ({ personId: personId(n), angle: "Their fans already love this show." }));

const VALID_INPUT: Record<ToolName, Record<string, unknown>> = {
  people_for_show: { reach: "any" },
  audience_of: { personId: personId(1) },
  trend_of: { personId: personId(1) },
  shared_taste: { personId: personId(1) },
  upcoming_releases: { kind: "movie" },
  find_person: { name: "Synthetic Name" },
  recent_episode_titles: {},
  finish_board: { picks: VALID_PICKS },
};

async function withPeople(): Promise<{ ctx: RunContext; qloo: MeteredQloo; ops: QlooOperation[] }> {
  const ctx = newContext();
  const { qloo, ops } = fakeQloo();
  await runTool(ctx, qloo, "people_for_show", { reach: "any" }, TODAY);
  return { ctx, qloo, ops };
}

describe("researchTools", () => {
  it("offers exactly the 8 tools, each strict with no extra keys and every property required", () => {
    const tools = researchTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(TOOL_LIMITS).sort());
    for (const tool of tools) {
      expect(tool.strict).toBe(true);
      expect(tool.input_schema.additionalProperties).toBe(false);
      expect(tool.input_schema.required).toEqual(Object.keys(tool.input_schema.properties as object));
    }
    const finish = tools.find((tool) => tool.name === "finish_board");
    const picks = (finish?.input_schema.properties as Record<string, { items: Record<string, unknown> }>)["picks"];
    expect(picks?.items["additionalProperties"]).toBe(false);
    expect(picks?.items["required"]).toEqual(["personId", "angle"]);
  });

  it("returns fresh objects, so a caller cannot change the next run's list", () => {
    const first = researchTools();
    const tool = first[0];
    if (tool) tool.description = "changed";

    expect(researchTools()[0]?.description).not.toBe("changed");
  });
});

describe("runTool refusals (C2.1, C2.2)", () => {
  it("refuses an unknown tool name with no Qloo call", async () => {
    const ctx = newContext();
    const { qloo, ops } = fakeQloo();

    for (const name of ["fetch_url", "__proto__", "toString", ""]) {
      const outcome = await runTool(ctx, qloo, name, {}, TODAY);
      expect(outcome.isError).toBe(true);
      expect(errorOf(outcome.content)).toEqual({ error: "UNKNOWN_TOOL" });
    }
    expect(ops).toHaveLength(0);
    expect(ctx.steps.every((entry) => entry.tool === "unknown" && !entry.ok)).toBe(true);
  });

  it("refuses an extra key on every tool with no Qloo call", async () => {
    const { ctx, qloo, ops } = await withPeople();
    const before = ops.length;

    for (const name of Object.keys(TOOL_LIMITS) as ToolName[]) {
      const outcome = await runTool(ctx, qloo, name, { ...VALID_INPUT[name], extra: 1 }, TODAY);
      expect(errorOf(outcome.content)).toEqual({ error: "BAD_INPUT" });
    }
    expect(ops).toHaveLength(before);
  });

  it("refuses wrong types, missing fields and over-long text with no Qloo call", async () => {
    const { ctx, qloo, ops } = await withPeople();
    const before = ops.length;
    const bad: Array<[ToolName, unknown]> = [
      ["people_for_show", { reach: "famous" }],
      ["audience_of", {}],
      ["trend_of", null],
      ["find_person", { name: "x".repeat(101) }],
      ["find_person", { name: "   " }],
      ["finish_board", { picks: VALID_PICKS.slice(0, 2) }],
    ];

    for (const [name, input] of bad) {
      expect(errorOf((await runTool(ctx, qloo, name, input, TODAY)).content)).toEqual({ error: "BAD_INPUT" });
    }
    expect(ops).toHaveLength(before);
  });

  it("refuses a personId no tool returned in this run with no Qloo call", async () => {
    const { ctx, qloo, ops } = await withPeople();
    const before = ops.length;

    for (const name of ["audience_of", "trend_of", "shared_taste"] as const) {
      const outcome = await runTool(ctx, qloo, name, { personId: NEVER_RETURNED }, TODAY);
      expect(errorOf(outcome.content)).toEqual({ error: "UNKNOWN_PERSON" });
    }
    expect(ops).toHaveLength(before);
  });

  it("refuses the 11th audience_of call with no Qloo call", async () => {
    const { ctx, qloo, ops } = await withPeople();
    for (let call = 0; call < 10; call += 1) {
      expect((await runTool(ctx, qloo, "audience_of", { personId: personId(1) }, TODAY)).isError).toBe(false);
    }
    const before = ops.length;

    const outcome = await runTool(ctx, qloo, "audience_of", { personId: personId(1) }, TODAY);

    expect(errorOf(outcome.content)).toEqual({ error: "LIMIT_REACHED" });
    expect(ops).toHaveLength(before);
  });

  it("surfaces a QlooError as its code only, with no message, URL or key", async () => {
    const ctx = newContext();
    const { qloo } = fakeQloo(() => {
      throw new QlooError("QLOO_RATE_LIMIT", 429);
    });

    const outcome = await runTool(ctx, qloo, "people_for_show", { reach: "any" }, TODAY);

    expect(outcome).toEqual({ content: JSON.stringify({ error: "QLOO_RATE_LIMIT" }), isError: true });
    expect(ctx.steps).toEqual([{ tool: "people_for_show", ok: false, summary: "failed: QLOO_RATE_LIMIT" }]);
  });

  it("rethrows an error that is not a QlooError so the run can fail", async () => {
    const ctx = newContext();
    const { qloo } = fakeQloo(() => {
      throw new TypeError("database down");
    });

    await expect(runTool(ctx, qloo, "people_for_show", { reach: "any" }, TODAY)).rejects.toThrow(TypeError);
  });
});

describe("tool requests and results", () => {
  it("asks Qloo for people with the reach limit and records them with rounded affinity", async () => {
    const ctx = newContext();
    const { qloo, ops } = fakeQloo();

    const outcome = await runTool(ctx, qloo, "people_for_show", { reach: "bookable" }, TODAY);
    await runTool(ctx, qloo, "people_for_show", { reach: "emerging" }, TODAY);
    await runTool(ctx, qloo, "people_for_show", { reach: "any" }, TODAY);

    expect(ops[0]).toEqual({
      op: "insights",
      filterType: "urn:entity:person",
      signalEntities: [SHOW.qlooId],
      take: 20,
      explainability: true,
      popularityMax: 0.9,
    });
    expect(ops[1]).toMatchObject({ popularityMax: 0.7 });
    expect(ops[2]).not.toHaveProperty("popularityMax");
    expect(JSON.parse(outcome.content).people[0]).toEqual({
      personId: personId(1),
      name: `Synthetic Person 1 ${MARKER}`,
      affinity: 0.99,
      reach: "bookable",
    });
    expect(ctx.people.get(personId(2))).toEqual({ name: `Synthetic Person 2 ${MARKER}`, affinity: 0.977, popularity: 0.51 });
  });

  it("fetches the show's audience once and returns a person's strongest segments as words", async () => {
    const { ctx, qloo, ops } = await withPeople();

    const first = await runTool(ctx, qloo, "audience_of", { personId: personId(1) }, TODAY);
    await runTool(ctx, qloo, "audience_of", { personId: personId(2) }, TODAY);

    expect(JSON.parse(first.content)).toEqual({ strongestWith: ["listeners 25 to 29", "women", "listeners 55 and older"] });
    expect(ops.flatMap((op) => (op.op === "demographics" ? [op.signalEntities] : []))).toEqual([
      [SHOW.qlooId],
      [personId(1)],
      [personId(2)],
    ]);
    expect(ctx.showDemographics).not.toBeNull();
    expect(ctx.personDemographics.size).toBe(2);
  });

  it("asks for the 12 full Monday to Sunday weeks before today and returns the trend state", async () => {
    const { ctx, qloo, ops } = await withPeople();

    const outcome = await runTool(ctx, qloo, "trend_of", { personId: personId(1) }, TODAY);

    expect(ops.at(-1)).toEqual({
      op: "trending",
      filterType: "urn:entity:person",
      entity: personId(1),
      startDate: "2026-07-27",
      endDate: "2026-10-18",
    });
    expect(JSON.parse(outcome.content)).toEqual({ trend: "rising" });
    expect(ctx.trends.get(personId(1))).toHaveLength(12);
  });

  it("compares the show with the person and returns the top shared tastes", async () => {
    const { ctx, qloo, ops } = await withPeople();

    const outcome = await runTool(ctx, qloo, "shared_taste", { personId: personId(1) }, TODAY);

    expect(ops.at(-1)).toEqual({ op: "compare", a: [SHOW.qlooId], b: [personId(1)], take: 10 });
    expect(JSON.parse(outcome.content)).toEqual({ sharedTastes: [`taste 0 ${MARKER}`, `taste 2 ${MARKER}`, `taste 1 ${MARKER}`] });
  });

  it("filters releases from today, by year for books, and returns titles only", async () => {
    const ctx = newContext();
    const { qloo, ops } = fakeQloo();

    const movies = await runTool(ctx, qloo, "upcoming_releases", { kind: "movie" }, TODAY);
    await runTool(ctx, qloo, "upcoming_releases", { kind: "book" }, TODAY);

    expect(ops[0]).toEqual({
      op: "insights",
      filterType: "urn:entity:movie",
      signalEntities: [SHOW.qlooId],
      take: 10,
      releaseDateMin: "2026-10-19",
    });
    expect(ops[1]).toEqual({
      op: "insights",
      filterType: "urn:entity:book",
      signalEntities: [SHOW.qlooId],
      take: 10,
      publicationYearMin: 2026,
    });
    expect(JSON.parse(movies.content)).toEqual({ titles: [`Synthetic Title 1 ${MARKER}`, `Synthetic Title 2 ${MARKER}`] });
    expect(ctx.people.size).toBe(0);
  });

  it("records a found person without affinity, so a search score never becomes fit", async () => {
    const ctx = newContext();
    const { qloo, ops } = fakeQloo();

    const outcome = await runTool(ctx, qloo, "find_person", { name: "  x&take=500#y  " }, TODAY);

    expect(ops[0]).toEqual({ op: "search", query: "x&take=500#y", types: ["urn:entity:person"], take: 3 });
    expect(JSON.parse(outcome.content)).toEqual({ people: [{ personId: personId(50), name: `Synthetic Found ${MARKER}` }] });
    expect(ctx.people.get(personId(50))).toEqual({ name: `Synthetic Found ${MARKER}`, affinity: null, popularity: 0.3 });
  });

  it("caps episode titles at 40, 200 characters each, strips direction controls, and keeps content under 4,000", async () => {
    const titles = Array.from({ length: 45 }, (_, n) => `‮${String(n).padStart(2, "0")} ${"t".repeat(250)}`);
    const ctx = newContext(titles);
    const { qloo, ops } = fakeQloo();

    const outcome = await runTool(ctx, qloo, "recent_episode_titles", {}, TODAY);
    const again = await runTool(ctx, qloo, "recent_episode_titles", {}, TODAY);
    const body = JSON.parse(outcome.content) as { titles: string[]; omitted: number };

    expect(outcome.content.length).toBeLessThanOrEqual(4_000);
    expect(body.titles.length + body.omitted).toBe(40);
    for (const [n, title] of body.titles.entries()) {
      expect(title).toBe(`${String(n).padStart(2, "0")} ${"t".repeat(197)}`);
    }
    expect(errorOf(again.content)).toEqual({ error: "LIMIT_REACHED" });
    expect(ops).toHaveLength(0);
  });

  it("keeps people_for_show content under 4,000 by dropping whole entries", async () => {
    const ctx = newContext();
    const { qloo } = fakeQloo(() =>
      synthPeople(20).map((person) => ({ ...person, name: `${person.name} ${"n".repeat(300)}` })),
    );

    const outcome = await runTool(ctx, qloo, "people_for_show", { reach: "any" }, TODAY);
    const body = JSON.parse(outcome.content) as { people: Array<{ name: string }>; omitted: number };

    expect(outcome.content.length).toBeLessThanOrEqual(4_000);
    expect(body.omitted).toBeGreaterThan(0);
    expect(body.people.length + body.omitted).toBe(20);
    expect(body.people.every((person) => [...person.name].length === 120)).toBe(true);
  });
});

describe("finish_board", () => {
  it("accepts valid picks and returns them with links removed and counted", async () => {
    const { ctx, qloo } = await withPeople();
    const picks = [
      { personId: personId(1), angle: "Their fans already love this show." },
      { personId: personId(2), angle: "A warm storyteller, see evil.example/login for more." },
      { personId: personId(3), angle: "Brings a younger crowd the show is missing." },
    ];

    const outcome = await runTool(ctx, qloo, "finish_board", { picks }, TODAY);

    expect(outcome.isError).toBe(false);
    expect(JSON.parse(outcome.content)).toEqual({ accepted: 3 });
    expect(outcome.finished).toEqual([
      picks[0],
      { personId: personId(2), angle: "A warm storyteller, see for more." },
      picks[2],
    ]);
    expect(ctx.steps.at(-1)).toEqual({ tool: "finish_board", ok: true, summary: "accepted 3 picks, removed 1 links and 0 emails" });
  });

  it("rejects a pick with a digit in its angle and a pick with an unknown id, saying which and why", async () => {
    const { ctx, qloo } = await withPeople();
    const picks = [
      { personId: personId(1), angle: "Their fans already love this show." },
      { personId: personId(2), angle: "Book them, fit 9.7/10" },
      { personId: NEVER_RETURNED, angle: "Invented guest." },
      { personId: personId(1), angle: "Same guest twice." },
    ];

    const outcome = await runTool(ctx, qloo, "finish_board", { picks }, TODAY);

    expect(outcome.isError).toBe(true);
    expect(outcome.finished).toBeUndefined();
    expect(JSON.parse(outcome.content)).toEqual({
      error: "PICKS_REJECTED",
      rejected: [
        { index: 1, reason: "digits" },
        { index: 2, reason: "unknown_person" },
        { index: 3, reason: "duplicate" },
      ],
    });
  });

  it("allows one retry and then refuses further calls", async () => {
    const { ctx, qloo } = await withPeople();
    const bad = { picks: VALID_PICKS.map((pick) => ({ ...pick, angle: "fit 9" })) };

    await runTool(ctx, qloo, "finish_board", bad, TODAY);
    await runTool(ctx, qloo, "finish_board", bad, TODAY);
    const third = await runTool(ctx, qloo, "finish_board", VALID_INPUT.finish_board, TODAY);

    expect(errorOf(third.content)).toEqual({ error: "LIMIT_REACHED" });
  });
});

describe("step summaries", () => {
  it("carry no person id, no show id and no upstream text across every tool", async () => {
    const ctx = newContext([`Episode with ${MARKER}`]);
    const { qloo } = fakeQloo();
    const calls: Array<[ToolName, unknown]> = [
      ["people_for_show", { reach: "any" }],
      ["audience_of", { personId: personId(1) }],
      ["trend_of", { personId: personId(1) }],
      ["shared_taste", { personId: personId(1) }],
      ["upcoming_releases", { kind: "tv_show" }],
      ["find_person", { name: `Someone ${MARKER}` }],
      ["recent_episode_titles", {}],
      ["audience_of", { personId: NEVER_RETURNED }],
      ["finish_board", VALID_INPUT.finish_board],
    ];

    for (const [name, input] of calls) await runTool(ctx, qloo, name, input, TODAY);
    const streamed = JSON.stringify(ctx.steps);

    expect(ctx.steps).toHaveLength(calls.length);
    expect(streamed).not.toContain(MARKER);
    expect(streamed).not.toContain("Synthetic");
    expect(streamed).not.toContain("00000000-");
    expect(ctx.steps.map((entry) => entry.summary)).toEqual([
      "found 3 people",
      "read one audience, 3 strong segments",
      "read 12 weeks of trend data, rising",
      "found 3 shared tastes",
      "found 2 upcoming TV shows",
      "found 1 matching people",
      "shared 1 episode titles",
      "refused: person not found in this run",
      "accepted 3 picks",
    ]);
  });
});
