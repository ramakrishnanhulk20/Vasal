// Covers the past-guest matcher on its own: which names a title, a
// description or a host entry marks as a past guest or a host, and which it
// must not, and sameName, which exclusions use. It does not cover where the
// run uses them (agent-tools, agent-board and agent-runner do), real feeds,
// nicknames, misspellings or lookalike letters from other scripts, which it
// does not try to match.
import { describe, expect, it } from "vitest";
import { isHost, isPastGuest, NO_PAST_GUESTS, pastGuestIndex, sameName, type PastGuestIndex } from "../src/agent/past-guests.js";

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
      const index = "titles" in titles ? titles : pastGuestIndex({ titles });

      expect(isPastGuest(index, name)).toBe(expected);
    });
  }

  it("keeps one padded key per title, so the 2,000th is still read", () => {
    const index = pastGuestIndex({ titles: LONG_FEED });

    expect(index.titles).toHaveLength(2_000);
    expect(index.titles.at(-1)).toBe(" synthetic guest on the last episode ");
    expect(Object.isFrozen(index) && Object.isFrozen(index.titles)).toBe(true);
    expect(NO_PAST_GUESTS).toEqual({ titles: [], descriptions: [], hosts: [] });
    expect(Object.isFrozen(NO_PAST_GUESTS.titles) && Object.isFrozen(NO_PAST_GUESTS.descriptions) && Object.isFrozen(NO_PAST_GUESTS.hosts)).toBe(true);
  });
});

// The live New Heights flip showed Peyton Manning as new and let Jason Kelce
// through (audit A2-1): titles and the show's own name hold two people at once.
describe("titles and host entries that name two people", () => {
  const index = pastGuestIndex({
    titles: ["Peyton and Eli Manning, Super Bowl 59 Preview | Ep 123", "Julie & Zach Ertz on life after football | EP 196"],
    hosts: ["New Heights with Jason & Travis Kelce", "Wondery"],
  });

  it("marks all six people from the audit as past guests", () => {
    for (const name of ["Peyton Manning", "Eli Manning", "Julie Ertz", "Zach Ertz", "Jason Kelce", "Travis Kelce"]) {
      expect(isPastGuest(index, name), name).toBe(true);
    }
  });

  it("calls only the two people the show's name holds hosts", () => {
    expect(isHost(index, "Jason Kelce")).toBe(true);
    expect(isHost(index, "Travis Kelce")).toBe(true);
    for (const name of ["Peyton Manning", "Eli Manning", "Julie Ertz", "Zach Ertz", "Wendy Wondery"]) expect(isHost(index, name), name).toBe(false);
  });

  it("finds a host the feed's authors name, in either order", () => {
    const fromAuthors = pastGuestIndex({ titles: ["Episode 12: a solo show"], hosts: ["Swisher, Kara"] });
    expect(isHost(fromAuthors, "Kara Swisher")).toBe(true);
    expect(isPastGuest(fromAuthors, "Kara Swisher")).toBe(true);
    expect(isHost(fromAuthors, "Kara Brown")).toBe(false);
  });

  it("never matches a longer word or a surname alone, in any kind of entry", () => {
    const near = pastGuestIndex({
      titles: ["Mel Kiperman on the draft", "Manning on the playoffs"],
      descriptions: ["Mel Kiperman joins", "The Manning family"],
      hosts: ["The Kiperman Hour", "Manning Media"],
    });
    for (const name of ["Mel Kiper", "Mel Kiper Jr.", "Peyton Manning"]) {
      expect(isPastGuest(near, name), name).toBe(false);
      expect(isHost(near, name), name).toBe(false);
    }
  });

  it("needs every word of a longer name apart, and the first and last side by side otherwise", () => {
    expect(isPastGuest(pastGuestIndex({ titles: ["Mary-Kate and Ashley Olsen"] }), "Mary-Kate Olsen")).toBe(true);
    expect(isPastGuest(pastGuestIndex({ titles: ["Michael B. Jordan on Creed"] }), "Michael I. Jordan")).toBe(false);
    expect(isPastGuest(pastGuestIndex({ titles: ["Jordan, Michael B."] }), "Michael B. Jordan")).toBe(true);
  });

  it("still matches a three-word name through the strict rule when a title holds only the first and last name", () => {
    const index = pastGuestIndex({ titles: ["Nassim Taleb on risk"] });
    expect(isPastGuest(index, "Nassim Nicholas Taleb")).toBe(true);
    expect(isPastGuest(pastGuestIndex({ titles: ["Taleb talks with Nassim"] }), "Nassim Nicholas Taleb")).toBe(false);
  });

  it("still needs the whole name for a one-word name or one that repeats a word", () => {
    expect(isPastGuest(pastGuestIndex({ titles: ["Duran on tour"] }), "Duran Duran")).toBe(false);
    expect(isPastGuest(pastGuestIndex({ titles: ["Duran Duran on tour"] }), "Duran Duran")).toBe(true);
    expect(isPastGuest(pastGuestIndex({ titles: ["Cher and Prince"] }), "Prince")).toBe(true);
  });
});

describe("descriptions", () => {
  it("match a name written side by side, whole, or in its short form", () => {
    const index = pastGuestIndex({
      titles: ["Episode 40"],
      descriptions: ["This week Peyton Manning stops by.", "Nassim Taleb returns", "w/ Meg Stalter"],
    });
    expect(isPastGuest(index, "Peyton Manning")).toBe(true);
    expect(isPastGuest(index, "Nassim Nicholas Taleb")).toBe(true);
    expect(isPastGuest(index, "Megan Stalter")).toBe(true);
    expect(isPastGuest(pastGuestIndex({ titles: [], descriptions: ["Nassim Nicholas Taleb returns"] }), "Nassim Taleb")).toBe(false);
  });

  it("do not match when the two names sit apart, though a title with the same words does", () => {
    const apart = "Peyton talks about growing up in the Manning family";
    expect(isPastGuest(pastGuestIndex({ titles: [], descriptions: [apart] }), "Peyton Manning")).toBe(false);
    expect(isPastGuest(pastGuestIndex({ titles: [apart] }), "Peyton Manning")).toBe(true);
  });

  it("never make anyone a host", () => {
    const index = pastGuestIndex({ titles: ["Jason Kelce returns"], descriptions: ["Jason Kelce joins"] });
    expect(isPastGuest(index, "Jason Kelce")).toBe(true);
    expect(isHost(index, "Jason Kelce")).toBe(false);
    expect(isHost(NO_PAST_GUESTS, "Jason Kelce")).toBe(false);
    expect(isHost(pastGuestIndex({ titles: [], hosts: ["Jason Kelce"] }), "")).toBe(false);
  });
});

describe("isPastGuest short first names", () => {
  // Las Culturistas titled Megan Stalter's 2021 episode "w/ Meg Stalter".
  it("matches a title word that starts with the first name's first three letters, before the same surname", () => {
    expect(isPastGuest(pastGuestIndex({ titles: ['"Neato Skeeto" (w/ Meg Stalter)'] }), "Megan Stalter")).toBe(true);
    expect(isPastGuest(pastGuestIndex({ titles: ["Chris Nolan on film"] }), "Christopher Nolan")).toBe(true);
    expect(isPastGuest(pastGuestIndex({ titles: ["Matt Rogers returns"] }), "Matthew Rogers")).toBe(true);
  });

  it("needs the same surname right after, at least three letters of first name, and never a surname alone", () => {
    expect(isPastGuest(pastGuestIndex({ titles: ["Meg Stall talks"] }), "Megan Stalter")).toBe(false);
    expect(isPastGuest(pastGuestIndex({ titles: ["Stalter Meg"] }), "Megan Stalter")).toBe(false);
    expect(isPastGuest(pastGuestIndex({ titles: ["Tyler Burrell"] }), "Ty Burrell")).toBe(false);
    expect(isPastGuest(pastGuestIndex({ titles: ["Mike Birbiglia live"] }), "Michael Birbiglia")).toBe(false);
    expect(isPastGuest(pastGuestIndex({ titles: ["Prince live"] }), "Prince")).toBe(true);
    expect(isPastGuest(pastGuestIndex({ titles: ["Meghan live"] }), "Megan")).toBe(false);
  });
});

describe("initials", () => {
  const SPELLINGS = ["J.J. Watt", "J. J. Watt", "JJ Watt"];

  it("lets J.J. Watt, J. J. Watt and JJ Watt match each other in a title, a description and a host entry", () => {
    for (const name of SPELLINGS) {
      for (const written of SPELLINGS) {
        expect(isPastGuest(pastGuestIndex({ titles: [`${written} on the pass rush`] }), name), `${name} in a title ${written}`).toBe(true);
        expect(isPastGuest(pastGuestIndex({ titles: [], descriptions: [`This week ${written} stops by.`] }), name), `${name} in a description ${written}`).toBe(true);
        expect(isHost(pastGuestIndex({ titles: [], hosts: [`The Watt House with ${written}`] }), name), `${name} hosting ${written}`).toBe(true);
        expect(sameName(name, written), `${name} and ${written}`).toBe(true);
      }
    }
  });

  it("keeps the spaced form too, so a single letter just before the initials does not hide them", () => {
    expect(isPastGuest(pastGuestIndex({ titles: ["Q&A: J. J. Watt"] }), "J.J. Watt")).toBe(true);
    expect(isPastGuest(pastGuestIndex({ titles: ["Michael B. Jordan on Creed"] }), "Michael I. Jordan")).toBe(false);
    expect(sameName("J. J. Watt", "T. J. Watt")).toBe(false);
  });

  it("matches joined initials after a stray letter such as w/ or Q&A, in a title or a description, and never other joined initials (audit R2)", () => {
    const pairs: Array<[string, string]> = [
      ["w/ J.J. Watt", "JJ Watt"],
      ["Ep. 12 w/ D.J. Khaled", "DJ Khaled"],
      ["Q&A: J.J. Watt", "JJ Watt"],
      ["w/ J.R.R. Tolkien scholars", "JRR Tolkien"],
    ];
    for (const [written, name] of pairs) {
      expect(isPastGuest(pastGuestIndex({ titles: [written] }), name), `${name} in ${written}`).toBe(true);
      expect(isPastGuest(pastGuestIndex({ titles: [], descriptions: [`This week ${written} stops by.`] }), name), `${name} in a description`).toBe(true);
    }
    expect(isPastGuest(pastGuestIndex({ titles: ["w/ J.J. Watt"] }), "J.J. Watt")).toBe(true);
    expect(isPastGuest(pastGuestIndex({ titles: ["w/ T.J. Watt"] }), "JJ Watt")).toBe(false);
    expect(isPastGuest(pastGuestIndex({ titles: ["T.J. Watt on defense"] }), "JJ Watt")).toBe(false);
  });

  it("keeps at most four keys for an entry, however many single letters it holds", () => {
    const letters = Array.from({ length: 1_000 }, (_, n) => String.fromCharCode(97 + (n % 26))).join(" ");

    const index = pastGuestIndex({ titles: [], descriptions: [letters] });

    expect(index.descriptions.length).toBeLessThanOrEqual(4);
    expect(pastGuestIndex({ titles: ["Dana Carvey Returns"] }).titles).toEqual([" dana carvey returns "]);
  });
});

describe("sameName", () => {
  it("is true for accents, a suffix, a middle name, case and punctuation, either way round", () => {
    expect(sameName("Jose Andres", "José Andrés")).toBe(true);
    expect(sameName("Mel Kiper", "Mel Kiper, Jr.")).toBe(true);
    expect(sameName("Mel Kiper, Jr.", "Mel Kiper")).toBe(true);
    expect(sameName("Nassim Taleb", "Nassim Nicholas Taleb")).toBe(true);
    expect(sameName("conan o'brien", "Conan O’Brien")).toBe(true);
  });

  it("is false for a different name, a longer word, a surname alone, a short first name and an empty name", () => {
    expect(sameName("Mel Kiper", "Mel Kiperman")).toBe(false);
    expect(sameName("Taleb", "Nassim Nicholas Taleb")).toBe(false);
    expect(sameName("Meg Stalter", "Megan Stalter")).toBe(false);
    expect(sameName("", "")).toBe(false);
    expect(sameName("Ann Lee", " ")).toBe(false);
  });
});
