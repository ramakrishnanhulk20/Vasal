// Covers the duration parser on hand-written strings. It does not cover
// whether every duration YouTube really sends fits these forms; only a live
// pull can show that, and an unreadable duration becomes null, not an error.
import { describe, expect, it } from "vitest";
import { isoDurationSeconds } from "../src/youtube/duration.js";

describe("isoDurationSeconds", () => {
  it("reads the forms YouTube sends", () => {
    const cases: Array<[string, number]> = [
      ["PT1H2M3S", 3_723],
      ["PT45M", 2_700],
      ["PT59S", 59],
      ["P1DT2H", 93_600],
      ["PT0S", 0],
      ["P0D", 0],
      ["P1DT2H3M4S", 93_784],
      ["PT1H", 3_600],
      ["PT2M30S", 150],
    ];
    for (const [text, seconds] of cases) {
      expect(isoDurationSeconds(text), text).toBe(seconds);
    }
  });

  it("returns null for junk, other ISO forms, and anything over 32 characters", () => {
    const junk = [
      "",
      "P",
      "PT",
      "P1DT",
      "PT5",
      "1H2M",
      "pt1h",
      " PT1S",
      "PT1S ",
      "PT1.5S",
      "PT-1S",
      "PT1S1M",
      "PT1M1H",
      "P1Y",
      "P1M",
      "P1W",
      "PT1HXS",
      "PT１S",
      "PT1S\n",
      `PT${"0".repeat(29)}1S`,
      "PT99999999999999999999S",
    ];
    for (const text of junk) {
      expect(isoDurationSeconds(text), JSON.stringify(text)).toBeNull();
    }
    expect(`PT${"0".repeat(28)}1S`).toHaveLength(32);
    expect(isoDurationSeconds(`PT${"0".repeat(28)}1S`)).toBe(1);
  });
});
