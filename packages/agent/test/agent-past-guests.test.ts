// Covers the past-guest matcher on its own: which names a title marks as a
// past guest, and which it must not. It does not cover where the run uses it
// (agent-tools and agent-runner do), real feeds, nicknames, misspellings or
// lookalike letters from other scripts, which it does not try to match.
import { describe, expect, it } from "vitest";
import { isPastGuest, NO_PAST_GUESTS, pastGuestIndex, type PastGuestIndex } from "../src/agent/past-guests.js";

const LONG_FEED = Array.from({ length: 2_000 }, (_, n) =>
  n === 1_999 ? "Synthetic Guest on the last episode" : `Episode ${n + 1}: a solo show`,
);

const cases: Array<{ name: string; titles: readonly string[] | PastGuestIndex; expected: boolean; why: string }> = [
  { name: "Dana Carvey", titles: ["Dana Carvey Returns"], expected: true, why: "the whole name" },
  { name: "Conan O'Brien", titles: ["Conan O’Brien and friends"], expected: true, why: "a curly apostrophe in the title" },
  { name: "Beyoncé", titles: ["beyonce live"], expected: true, why: "an accent and case" },
  { name: "Mel Kiper, Jr.", titles: ["Mel Kiper Jr. on the draft"], expected: true, why: "a suffix and its punctuation" },
  { name: "David A. Sinclair", titles: ["David Sinclair: Why We Age"], expected: true, why: "a middle initial the title leaves out" },
  { name: "Nassim Nicholas Taleb", titles: ["Nassim Taleb on risk"], expected: true, why: "a middle name the title leaves out" },
  { name: "Keegan-Michael Key", titles: ["Keegan Michael Key"], expected: true, why: "a hyphen the title writes as a space" },
  { name: "Nassim Nicholas Taleb", titles: ["Taleb"], expected: false, why: "a surname alone" },
  { name: "Ann Lee", titles: ["Annie Leeds"], expected: false, why: "a name inside longer words" },
  { name: "Tony Hale", titles: ["Tony Hales"], expected: false, why: "a surname that is the start of a longer word" },
  { name: "Ben Goertzel", titles: NO_PAST_GUESTS, expected: false, why: "a show whose feed could not be read" },
  { name: "", titles: ["Dana Carvey Returns", "", " "], expected: false, why: "an empty name" },
  { name: "Synthetic Guest", titles: LONG_FEED, expected: true, why: "the last title of a 2,000-title feed" },
];

describe("isPastGuest", () => {
  for (const { name, titles, expected, why } of cases) {
    it(`${expected ? "matches" : "does not match"} ${why}`, () => {
      const index = "titles" in titles ? titles : pastGuestIndex(titles);

      expect(isPastGuest(index, name)).toBe(expected);
    });
  }

  it("keeps one padded key per title, so the 2,000th is still read", () => {
    const index = pastGuestIndex(LONG_FEED);

    expect(index.titles).toHaveLength(2_000);
    expect(index.titles.at(-1)).toBe(" synthetic guest on the last episode ");
    expect(Object.isFrozen(index) && Object.isFrozen(index.titles)).toBe(true);
    expect(NO_PAST_GUESTS.titles).toEqual([]);
    expect(Object.isFrozen(NO_PAST_GUESTS.titles)).toBe(true);
  });
});

describe("isPastGuest short first names", () => {
  // Las Culturistas titled Megan Stalter's 2021 episode "w/ Meg Stalter".
  it("matches a title word that starts with the first name's first three letters, before the same surname", () => {
    expect(isPastGuest(pastGuestIndex(['"Neato Skeeto" (w/ Meg Stalter)']), "Megan Stalter")).toBe(true);
    expect(isPastGuest(pastGuestIndex(["Chris Nolan on film"]), "Christopher Nolan")).toBe(true);
    expect(isPastGuest(pastGuestIndex(["Matt Rogers returns"]), "Matthew Rogers")).toBe(true);
  });

  it("needs the same surname right after, at least three letters of first name, and never a surname alone", () => {
    expect(isPastGuest(pastGuestIndex(["Meg Stall talks"]), "Megan Stalter")).toBe(false);
    expect(isPastGuest(pastGuestIndex(["Stalter Meg"]), "Megan Stalter")).toBe(false);
    expect(isPastGuest(pastGuestIndex(["Tyler Burrell"]), "Ty Burrell")).toBe(false);
    expect(isPastGuest(pastGuestIndex(["Mike Birbiglia live"]), "Michael Birbiglia")).toBe(false);
    expect(isPastGuest(pastGuestIndex(["Prince live"]), "Prince")).toBe(true);
    expect(isPastGuest(pastGuestIndex(["Meghan live"]), "Megan")).toBe(false);
  });
});
