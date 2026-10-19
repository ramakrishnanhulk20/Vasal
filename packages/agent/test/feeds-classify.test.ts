// Not covered here: whether a classified feed URL is safe to fetch (that is
// safe-fetch.test.ts) and whether an Apple id exists (feeds-lookup.test.ts).
import { describe, expect, it } from "vitest";
import { classifyInput } from "../src/feeds/classify.js";
import { FeedError } from "../src/feeds/errors.js";

function badInputCode(raw: string): string | null {
  try {
    classifyInput(raw);
    return null;
  } catch (err) {
    return err instanceof FeedError ? err.code : "not a FeedError";
  }
}

describe("C8.2 the WHATWG parser alone decides what was typed", () => {
  it("reads an Apple Podcasts link as an Apple id", () => {
    expect(classifyInput("https://podcasts.apple.com/us/podcast/smartless/id1521578868")).toEqual({
      kind: "apple",
      appleId: "1521578868",
    });
    expect(classifyInput("  HTTPS://Podcasts.Apple.com/us/podcast/x/id123456?i=1  ")).toEqual({
      kind: "apple",
      appleId: "123456",
    });
  });

  it("treats an Apple lookalike host as an ordinary feed URL", () => {
    const result = classifyInput("https://podcasts.apple.com.evil.example/us/podcast/x/id1521578868");
    expect(result.kind).toBe("feed");
    expect(result.kind === "feed" && result.url.hostname).toBe("podcasts.apple.com.evil.example");
  });

  it("refuses an Apple link with no usable id instead of fetching the page", () => {
    expect(() => classifyInput("https://podcasts.apple.com/us/browse")).toThrow(
      expect.objectContaining({ code: "FEED_BAD_INPUT" }),
    );
    expect(() => classifyInput("https://podcasts.apple.com/us/podcast/x/id12")).toThrow(
      expect.objectContaining({ code: "FEED_BAD_INPUT" }),
    );
  });

  it("reads an http or https URL as a feed", () => {
    const result = classifyInput("https://feeds.simplecast.com/hNaFxXpO");
    expect(result).toEqual({ kind: "feed", url: new URL("https://feeds.simplecast.com/hNaFxXpO") });
  });

  it("reads a javascript: string and other schemes as a show name", () => {
    expect(classifyInput("javascript:alert(1)")).toEqual({ kind: "name", text: "javascript:alert(1)" });
    expect(classifyInput("ftp://example.com/feed.xml").kind).toBe("name");
  });

  it("reads plain text, including URL-looking text without a scheme, as a show name", () => {
    expect(classifyInput("SmartLess")).toEqual({ kind: "name", text: "SmartLess" });
    expect(classifyInput("x&take=500#y")).toEqual({ kind: "name", text: "x&take=500#y" });
    expect(classifyInput("smartless.com/feed")).toEqual({ kind: "name", text: "smartless.com/feed" });
  });

  it("NFC-normalises and trims before deciding", () => {
    expect(classifyInput("  Café Stories \n")).toEqual({ kind: "name", text: "Café Stories" });
  });

  it("rejects empty input and input over 300 characters", () => {
    expect(badInputCode("")).toBe("FEED_BAD_INPUT");
    expect(badInputCode("   \t\n")).toBe("FEED_BAD_INPUT");
    expect(badInputCode("a".repeat(301))).toBe("FEED_BAD_INPUT");
    expect(badInputCode("a".repeat(300))).toBeNull();
  });
});
