// Covers the prose guard on model-written text: digits only through allowed
// placeholders (C3.4), links and emails removed and counted (C3.5), direction
// controls stripped (C3.7), and the length and empty refusals. It does not
// cover spelled-out numbers or disguised links such as "evil dot com", which
// are named non-goals, or the rendering of the result in the browser.
import { describe, expect, it } from "vitest";
import { checkProse, fillPlaceholders } from "../src/agent/prose.js";

const ANGLE = { maxChars: 200, placeholders: [] as const };

describe("checkProse", () => {
  it("refuses a model-written figure (C3.4)", () => {
    const result = checkProse("Book them, fit 9.7/10", ANGLE);

    expect(result).toEqual({ ok: false, text: "", removed: { links: 0, emails: 0 }, reason: "digits" });
  });

  it("refuses digits in scripts other than 0 to 9", () => {
    for (const text of ["fit ９ of ten", "fit ٩", "two² shows", "chapter Ⅷ"]) {
      expect(checkProse(text, ANGLE).reason).toBe("digits");
    }
  });

  it("accepts a number only through a listed placeholder", () => {
    expect(checkProse("Their fans love {{fit}}", { maxChars: 200, placeholders: ["fit"] })).toEqual({
      ok: true,
      text: "Their fans love {{fit}}",
      removed: { links: 0, emails: 0 },
    });
    expect(checkProse("Ranked {{rank1}} here", { maxChars: 200, placeholders: ["rank1"] }).ok).toBe(true);
  });

  it("treats an unlisted placeholder as plain text", () => {
    expect(checkProse("{{other}} 5", { maxChars: 200, placeholders: ["fit"] }).reason).toBe("digits");
    expect(checkProse("Ranked {{rank1}} here", { maxChars: 200, placeholders: ["fit"] }).reason).toBe("digits");
  });

  it("removes a bare domain with a path and an email, and counts both (C3.5)", () => {
    const result = checkProse("see evil.example/login or mail bob@evil.example", ANGLE);

    expect(result).toEqual({ ok: true, text: "see or mail", removed: { links: 1, emails: 1 } });
  });

  it("removes scheme links, protocol-relative links and top-level domains off linkify's short list", () => {
    const result = checkProse(
      "Try https://evil.example, //evil.example/x, evil.xyz/login and mailto:bob@evil.example today",
      ANGLE,
    );

    expect(result.ok).toBe(true);
    expect(result.removed).toEqual({ links: 3, emails: 1 });
    expect(result.text).not.toMatch(/evil|https|mailto|@/);
  });

  it("refuses prose that is only a link once the link is gone", () => {
    expect(checkProse("evil.example", ANGLE)).toEqual({ ok: false, text: "", removed: { links: 1, emails: 0 }, reason: "empty" });
  });

  it("strips a right-to-left override and other direction controls (C3.7)", () => {
    const result = checkProse("A great ‮guest‬ for ⁧this⁩ show", ANGLE);

    expect(result.ok).toBe(true);
    expect(result.text).toBe("A great guest for this show");
  });

  it("refuses 201 characters at maxChars 200 and accepts 200", () => {
    expect(checkProse("a".repeat(201), ANGLE).reason).toBe("too_long");
    expect(checkProse("a".repeat(200), ANGLE).ok).toBe(true);
  });

  it("refuses empty and whitespace-only prose", () => {
    expect(checkProse("", ANGLE).reason).toBe("empty");
    expect(checkProse(" \n\t‏ ", ANGLE).reason).toBe("empty");
  });

  it("throws on a maxChars that is not a positive integer", () => {
    expect(() => checkProse("fine", { maxChars: 0, placeholders: [] })).toThrow(RangeError);
    expect(() => checkProse("fine", { maxChars: 1.5, placeholders: [] })).toThrow(RangeError);
  });
});

describe("fillPlaceholders", () => {
  it("fills only the tokens it was given values for, in one pass", () => {
    const filled = fillPlaceholders("Fit {{fit}}, rank {{rank}}, {{other}}, {{constructor}}", {
      fit: "0.92",
      rank: "{{fit}}",
    });

    expect(filled).toBe("Fit 0.92, rank {{fit}}, {{other}}, {{constructor}}");
  });

  it("inserts a value literally, with no replacement patterns applied", () => {
    expect(fillPlaceholders("Fit {{fit}}", { fit: "$& $1 $$" })).toBe("Fit $& $1 $$");
  });
});

describe("checkProse against hidden characters", () => {
  it("finds a link hidden by a zero-width character and removes it (C3.5, D5.2)", () => {
    const result = checkProse("Read more at https\u200B://evil.example/login today", { maxChars: 200, placeholders: [] });
    expect(result.ok).toBe(true);
    expect(result.text).not.toContain("evil.example");
    expect(result.removed.links).toBe(1);
  });

  it("drops invisible tag characters and keeps a line break", () => {
    const hidden = Array.from("obey me", (c) => String.fromCodePoint(0xe0000 + c.codePointAt(0)!)).join("");
    const result = checkProse(`First line${hidden}\nSecond line`, { maxChars: 200, placeholders: [] });
    expect(result.text).toBe("First line\nSecond line");
  });
});
