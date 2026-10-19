// Covers the episode window, the length rule, the C9.1 name-in-title check
// and the podcast name match. It does not cover the order the pipeline
// applies them in or how drops are counted (backtest-pipeline.test.ts), or
// how well a model extracts names, which the hand-checked precision sample
// measures.
import { describe, expect, it } from "vitest";
import {
  isFullLength,
  isInWindow,
  nameAppearsInTitle,
  pickPodcastMatch,
  podcastNameMatches,
} from "../src/backtest/eligibility.js";
import { normalizeName } from "../src/text/normalize.js";

describe("episode window, 2024-10-01 to 2026-07-31 inclusive in UTC", () => {
  it("includes both edge days and excludes the minute either side", () => {
    expect(isInWindow("2024-10-01T00:00Z")).toBe(true);
    expect(isInWindow("2024-09-30T23:59Z")).toBe(false);
    expect(isInWindow("2026-07-31T23:59Z")).toBe(true);
    expect(isInWindow("2026-07-31T23:59:59.999Z")).toBe(true);
    expect(isInWindow("2026-08-01")).toBe(false);
    expect(isInWindow("2026-08-01T00:00:00Z")).toBe(false);
  });

  it("reads offsets as the instant they name", () => {
    expect(isInWindow("2024-10-01T01:00:00+01:00")).toBe(true);
    expect(isInWindow("2024-10-01T00:30:00+01:00")).toBe(false);
    expect(isInWindow("2026-07-31T20:00:00-04:00")).toBe(false);
  });

  it("treats anything that is not an ISO instant with an offset as outside the window", () => {
    expect(isInWindow("2025-02-30T00:00:00Z")).toBe(false);
    expect(isInWindow("Oct 1 2025")).toBe(false);
    expect(isInWindow("2025-06-01T12:00:00")).toBe(false);
    expect(isInWindow("")).toBe(false);
  });
});

describe("full-length rule, at least 1200 seconds", () => {
  it("drops 1199 seconds and keeps 1200", () => {
    expect(isFullLength(1199)).toBe(false);
    expect(isFullLength(1200)).toBe(true);
    expect(isFullLength(7_200)).toBe(true);
  });

  it("treats an unknown length as too short", () => {
    expect(isFullLength(null)).toBe(false);
    expect(isFullLength(Number.NaN)).toBe(false);
  });
});

describe("C9.1 nameAppearsInTitle", () => {
  it("matches across case and spacing, under the shared normaliser", () => {
    expect(nameAppearsInTitle("Dax Shepard", "#123 DAX  SHEPARD on fame")).toBe(true);
    expect(nameAppearsInTitle("Dax​ Shepard", "Dax Shepard on fame")).toBe(true);
    expect(nameAppearsInTitle("Ｄax Shepard", "Dax Shepard on fame")).toBe(true);
    expect(nameAppearsInTitle("Mikey Madison", "Mikey Madison Reckons with Spicy Wings | Hot Ones")).toBe(true);
    expect(nameAppearsInTitle("Joey Diaz", "Joey Diaz | This Past Weekend w/ Theo Von #685")).toBe(true);
  });

  it("needs whole words, in any script", () => {
    expect(nameAppearsInTitle("Dax", "Daxton tells all")).toBe(false);
    expect(nameAppearsInTitle("Shepard", "The Shepardson story")).toBe(false);
    expect(nameAppearsInTitle("Björk", "BJÖRK | Hot Ones")).toBe(true);
    expect(nameAppearsInTitle("Björk", "Björkman on film")).toBe(false);
    expect(nameAppearsInTitle("Conan O'Brien", "Conan O'Brien's long night")).toBe(true);
    expect(nameAppearsInTitle("Ann", "Ann, Bob and more")).toBe(true);
    expect(nameAppearsInTitle("Ann", "Joanne and Annie")).toBe(false);
  });

  it("finds a later whole-word match after an earlier partial one", () => {
    expect(nameAppearsInTitle("Dax", "Daxton meets Dax")).toBe(true);
  });

  it("drops names the model invented or changed", () => {
    expect(nameAppearsInTitle("Dax Shepard", "Kristen Bell on fame")).toBe(false);
    expect(nameAppearsInTitle("Dax Shephard", "Dax Shepard on fame")).toBe(false);
    expect(nameAppearsInTitle("", "Dax Shepard on fame")).toBe(false);
    expect(nameAppearsInTitle("​ ", "Dax Shepard on fame")).toBe(false);
  });
});

describe("podcastNameMatches, the change-log definition", () => {
  it("matches equal names and a name followed by more words, either way round", () => {
    expect(podcastNameMatches("Armchair Expert with Dax Shepard", "Armchair Expert")).toBe(true);
    expect(podcastNameMatches("Armchair Expert", "Armchair Expert with Dax Shepard")).toBe(true);
    expect(podcastNameMatches("Armchair", "Armchair Expert")).toBe(true);
    expect(podcastNameMatches("SMARTLESS", "SmartLess")).toBe(true);
  });

  it("treats typographic and ASCII apostrophes as the same, through the shared normaliser", () => {
    expect(normalizeName("Conan O’Brien Needs A Friend")).toBe(normalizeName("Conan O'Brien Needs A Friend"));
    expect(podcastNameMatches("Conan O'Brien Needs A Friend", "Conan O’Brien Needs A Friend")).toBe(true);
  });

  it("does not match a longer word or a different name", () => {
    expect(podcastNameMatches("Armchair Expertise", "Armchair Expert")).toBe(false);
    expect(podcastNameMatches("Armchair Expert", "The Armchair Expert")).toBe(false);
    expect(podcastNameMatches("Hot Ones", "Hot Ones: The Classic Interviews")).toBe(false);
    expect(podcastNameMatches("", "Armchair Expert")).toBe(false);
  });
});

describe("pickPodcastMatch, the two-tier rule", () => {
  it("lets an exact match beat a longer name", () => {
    expect(
      pickPodcastMatch("Flagrant", [
        { id: "synthetic-podcast-1", name: "Flagrant" },
        { id: "synthetic-podcast-2", name: "Flagrant and Funny with Cari Champion" },
      ]),
    ).toEqual({ kind: "match", id: "synthetic-podcast-1", name: "Flagrant" });
  });

  it("matches across apostrophe styles in the exact tier", () => {
    expect(
      pickPodcastMatch("Conan O'Brien Needs A Friend", [
        { id: "synthetic-podcast-3", name: "Conan O\u2019Brien Needs A Friend" },
        { id: "synthetic-podcast-4", name: "Conan O'Brien Needs A Friend Fan Talk" },
      ]),
    ).toEqual({ kind: "match", id: "synthetic-podcast-3", name: "Conan O\u2019Brien Needs A Friend" });
  });

  it("is ambiguous when two exact matches carry different ids, and not when they share one", () => {
    expect(
      pickPodcastMatch("Hot Ones", [
        { id: "synthetic-podcast-5", name: "Hot Ones" },
        { id: "synthetic-podcast-6", name: "HOT  ONES" },
      ]),
    ).toEqual({ kind: "ambiguous" });
    expect(
      pickPodcastMatch("Hot Ones", [
        { id: "synthetic-podcast-5", name: "Hot Ones" },
        { id: "synthetic-podcast-5", name: "hot ones" },
        { id: "synthetic-podcast-7", name: "Hot Ones & Talks" },
      ]),
    ).toEqual({ kind: "match", id: "synthetic-podcast-5", name: "Hot Ones" });
  });

  it("uses the longer-name tier only when there is no exact match, and is ambiguous with two there", () => {
    expect(
      pickPodcastMatch("Armchair Expert with Dax Shepard", [{ id: "synthetic-podcast-8", name: "Armchair Expert" }]),
    ).toEqual({ kind: "match", id: "synthetic-podcast-8", name: "Armchair Expert" });
    expect(
      pickPodcastMatch("Hot Ones", [
        { id: "synthetic-podcast-7", name: "Hot Ones & Talks" },
        { id: "synthetic-podcast-9", name: "Hot Ones Uncut" },
      ]),
    ).toEqual({ kind: "ambiguous" });
  });

  it("gives none when nothing matches in either tier", () => {
    expect(pickPodcastMatch("Hot Ones", [{ id: "synthetic-podcast-10", name: "Hot Ones: The Classic Interviews" }])).toEqual({
      kind: "none",
    });
    expect(pickPodcastMatch("Hot Ones", [])).toEqual({ kind: "none" });
    expect(pickPodcastMatch("", [{ id: "synthetic-podcast-11", name: "" }])).toEqual({ kind: "none" });
  });
});
