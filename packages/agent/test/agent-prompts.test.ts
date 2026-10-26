// Covers the release and family rules in the fixed prompts: the research
// prompt carries the release rule right after the line about spotting people
// with a release, and the family rule after the accusations rule, with trends
// and the past-guest check on or off, and the brief prompt carries both among
// its rules. It also covers the brings wording: no fixed prompt says the show
// does not reach a group or that a guest would add or bring listeners. The
// research prompt's full text and its other rules are covered
// in agent-loop, and the brief prompt's other rules in agent-brief. It does
// not cover whether the real model follows the rules; checkProse refuses a
// release or family claim either way (agent-prose).
import { describe, expect, it } from "vitest";
import { BRIEF_SYSTEM, EXTRACT_SYSTEM, RESEARCH_NUDGE, researchSystem, WITHOUT_QLOO_SYSTEM } from "../src/agent/prompts.js";
import { ACCUSATIONS_RULE, FAMILY_RULE, RELEASE_CLAIM_RULE } from "../src/agent/prose.js";

const RELEASES_LINE =
  "upcoming_releases and find_person help you spot people with a film, show or book coming out, who are often keen to do podcasts.";

describe("the release rule (A2-5)", () => {
  it("follows the upcoming releases line in every research prompt", () => {
    for (const trends of [true, false]) {
      for (const pastGuestsChecked of [true, false]) {
        const prompt = researchSystem({ trends, pastGuestsChecked });
        expect(prompt, `${trends} ${pastGuestsChecked}`).toContain(`${RELEASES_LINE} ${RELEASE_CLAIM_RULE} Never call a tool twice`);
      }
    }
  });

  it("is one of the brief prompt's rules, after the accusations rule", () => {
    expect(BRIEF_SYSTEM).toContain(`${ACCUSATIONS_RULE} ${RELEASE_CLAIM_RULE}`);
  });
});

describe("the family rule", () => {
  it("follows the accusations rule in every research prompt", () => {
    for (const trends of [true, false]) {
      for (const pastGuestsChecked of [true, false]) {
        expect(researchSystem({ trends, pastGuestsChecked }), `${trends} ${pastGuestsChecked}`).toContain(`${ACCUSATIONS_RULE} ${FAMILY_RULE}`);
      }
    }
  });

  it("follows the release rule in the brief prompt", () => {
    expect(BRIEF_SYSTEM).toContain(`${RELEASE_CLAIM_RULE} ${FAMILY_RULE}`);
  });
});

describe("the brings wording", () => {
  const researchPrompts = [true, false].flatMap((trends) =>
    [true, false].map((pastGuestsChecked) => researchSystem({ trends, pastGuestsChecked })),
  );

  it("never says the show does not reach a group or that a guest would add or bring listeners, in any fixed prompt", () => {
    for (const prompt of [...researchPrompts, BRIEF_SYSTEM, WITHOUT_QLOO_SYSTEM, EXTRACT_SYSTEM, RESEARCH_NUDGE]) {
      expect(prompt).not.toMatch(/does not reach|would add|would bring|new listeners/i);
    }
  });

  it("asks the research step for guests whose fans lean toward an audience group more than the show's listeners do", () => {
    for (const prompt of researchPrompts) {
      expect(prompt).toContain("- people whose fans lean toward an audience group more than this show's listeners do.");
    }
  });
});
