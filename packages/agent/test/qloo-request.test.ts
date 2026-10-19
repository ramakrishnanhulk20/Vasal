// Covers the operation schema and the request builder only. It does not
// cover sending (qloo-client.test.ts), response parsing, or whether Qloo
// honours each parameter, which only the live probe can show.
import { describe, expect, it } from "vitest";
import { QlooError } from "../src/qloo/errors.js";
import { buildQlooRequest, type QlooOperation } from "../src/qloo/request.js";

const BASE = new URL("https://hackathon.api.qloo.com");
const PODCAST = "8119141A-1111-2222-3333-444455556666";
const PERSON_A = "AAAAAAAA-0000-0000-0000-000000000001";
const PERSON_B = "BBBBBBBB-0000-0000-0000-000000000002";

function badInputCode(op: unknown): string | undefined {
  try {
    buildQlooRequest(BASE, op as QlooOperation);
  } catch (error) {
    return error instanceof QlooError ? error.code : "not a QlooError";
  }
  return undefined;
}

describe("buildQlooRequest", () => {
  it("keeps a hostile show name inside one query parameter and leaves take unchanged (C2.3)", () => {
    const request = buildQlooRequest(BASE, {
      op: "search",
      query: "x&take=500#y",
      types: ["urn:entity:podcast"],
      take: 5,
    });

    expect(request.url.searchParams.getAll("query")).toEqual(["x&take=500#y"]);
    expect(request.url.searchParams.getAll("take")).toEqual(["5"]);
    expect([...request.url.searchParams.keys()].sort()).toEqual(["query", "take", "types"]);
    expect(request.url.hash).toBe("");
    expect(request.url.origin).toBe("https://hackathon.api.qloo.com");
    expect(request.url.pathname).toBe("/search");
  });

  it("uses only the origin of the base URL, never a path or query from it", () => {
    const request = buildQlooRequest(new URL("https://hackathon.api.qloo.com/elsewhere?take=50#frag"), {
      op: "tags",
      query: "comedy",
    });

    expect(request.url.href).toBe("https://hackathon.api.qloo.com/v2/tags?filter.query=comedy");
  });

  it("maps every operation to its documented path and parameter names", () => {
    const cases: Array<[QlooOperation, string, Array<[string, string]>]> = [
      [
        { op: "search", query: "SmartLess", types: ["urn:entity:podcast"], take: 5 },
        "/search",
        [
          ["query", "SmartLess"],
          ["take", "5"],
          ["types", "urn:entity:podcast"],
        ],
      ],
      [
        {
          op: "insights",
          filterType: "urn:entity:person",
          signalEntities: [PODCAST],
          take: 20,
          popularityMax: 0.8,
          popularityMin: 0.1,
          explainability: true,
          resultEntities: [PERSON_A],
          releaseDateMin: "2026-10-19",
          publicationYearMin: 2026,
        },
        "/v2/insights",
        [
          ["feature.explainability", "true"],
          ["filter.popularity.max", "0.8"],
          ["filter.popularity.min", "0.1"],
          ["filter.publication_year.min", "2026"],
          ["filter.release_date.min", "2026-10-19"],
          ["filter.results.entities", PERSON_A],
          ["filter.type", "urn:entity:person"],
          ["signal.interests.entities", PODCAST],
          ["take", "20"],
        ],
      ],
      [
        { op: "demographics", signalEntities: [PODCAST] },
        "/v2/insights",
        [
          ["filter.type", "urn:demographics"],
          ["signal.interests.entities", PODCAST],
        ],
      ],
      [
        {
          op: "trending",
          filterType: "urn:entity:person",
          entity: PERSON_A,
          startDate: "2026-07-27",
          endDate: "2026-10-18",
        },
        "/v2/trending",
        [
          ["filter.end_date", "2026-10-18"],
          ["filter.start_date", "2026-07-27"],
          ["filter.type", "urn:entity:person"],
          ["signal.interests.entities", PERSON_A],
        ],
      ],
      [
        { op: "compare", a: [PODCAST], b: [PERSON_A], take: 10 },
        "/v2/analysis/compare",
        [
          ["a.signal.interests.entities", PODCAST],
          ["b.signal.interests.entities", PERSON_A],
          ["take", "10"],
        ],
      ],
      [
        { op: "tags", query: "true crime", take: 3 },
        "/v2/tags",
        [
          ["filter.query", "true crime"],
          ["take", "3"],
        ],
      ],
    ];

    for (const [op, path, params] of cases) {
      const request = buildQlooRequest(BASE, op);
      expect(request.method).toBe("GET");
      expect(request.path).toBe(path);
      expect(request.url.pathname).toBe(path);
      expect(request.params).toEqual(params);
      expect([...request.url.searchParams.entries()]).toEqual(params);
    }
  });

  it("sorts params by key, and comma-joins each list in a fixed order", () => {
    const request = buildQlooRequest(BASE, {
      op: "compare",
      a: [PERSON_B, PODCAST, PERSON_A],
      b: [PERSON_A],
    });

    expect(request.params).toEqual([
      ["a.signal.interests.entities", [PODCAST, PERSON_A, PERSON_B].join(",")],
      ["b.signal.interests.entities", PERSON_A],
    ]);
  });

  it("gives the same cacheKey to ops that differ only in list order, and a new key for any changed value (C7.1)", () => {
    const base: QlooOperation = {
      op: "insights",
      filterType: "urn:entity:person",
      signalEntities: [PODCAST, PERSON_A],
      take: 20,
    };
    const reordered: QlooOperation = { ...base, signalEntities: [PERSON_A, PODCAST] };
    const key = buildQlooRequest(BASE, base).cacheKey;

    expect(buildQlooRequest(BASE, reordered).cacheKey).toBe(key);
    expect(
      buildQlooRequest(BASE, { op: "search", query: "q", types: ["urn:entity:person", "urn:entity:podcast"] })
        .cacheKey,
    ).toBe(
      buildQlooRequest(BASE, { op: "search", query: "q", types: ["urn:entity:podcast", "urn:entity:person"] })
        .cacheKey,
    );

    const changed: QlooOperation[] = [
      { ...base, take: 21 },
      { ...base, signalEntities: [PODCAST, PERSON_B] },
      { ...base, filterType: "urn:entity:podcast" },
      { ...base, popularityMax: 0.8 },
      { ...base, explainability: true },
    ];
    for (const op of changed) {
      expect(buildQlooRequest(BASE, op).cacheKey).not.toBe(key);
    }
    expect(buildQlooRequest(new URL("https://other.example"), base).cacheKey).not.toBe(key);
  });

  it("builds the cacheKey from the same encoded query the URL carries", () => {
    const request = buildQlooRequest(BASE, { op: "search", query: "Literally! With Rob Lowe", types: ["urn:entity:podcast"] });

    expect(request.cacheKey).toBe(`GET ${request.url.host}${request.url.pathname}${request.url.search}`);
    expect(request.cacheKey).toBe(
      "GET hackathon.api.qloo.com/search?query=Literally%21+With+Rob+Lowe&types=urn%3Aentity%3Apodcast",
    );
  });

  it("rejects an unknown key, an over-long string, take 51 and a bad entity id with QLOO_BAD_INPUT", () => {
    expect(badInputCode({ op: "search", query: "q", types: ["urn:entity:podcast"], url: "https://evil.example" })).toBe(
      "QLOO_BAD_INPUT",
    );
    expect(badInputCode({ op: "search", query: "q".repeat(301), types: ["urn:entity:podcast"] })).toBe(
      "QLOO_BAD_INPUT",
    );
    expect(badInputCode({ op: "tags", query: "q", take: 51 })).toBe("QLOO_BAD_INPUT");
    for (const id of ["short", "has space-1234", "x&take=500", "../../etc/passwd", "A".repeat(65)]) {
      expect(badInputCode({ op: "demographics", signalEntities: [id] })).toBe("QLOO_BAD_INPUT");
    }
  });

  it("rejects the other out-of-range and malformed inputs with QLOO_BAD_INPUT", () => {
    const rejected: unknown[] = [
      { op: "search", query: "q".repeat(300), types: ["urn:entity:podcast"], take: 0 },
      { op: "search", query: "", types: ["urn:entity:podcast"] },
      { op: "search", query: "lone \uD800 surrogate", types: ["urn:entity:podcast"] },
      { op: "search", query: "q", types: ["urn:entity:music"] },
      { op: "search", query: "q", types: [] },
      { op: "insights", filterType: "urn:entity:person", signalEntities: [PODCAST], popularityMax: 1.5 },
      { op: "insights", filterType: "urn:entity:person", signalEntities: [PODCAST], popularityMin: 0.9, popularityMax: 0.1 },
      { op: "insights", filterType: "urn:entity:person", signalEntities: [PODCAST], take: 2.5 },
      { op: "insights", filterType: "urn:entity:person", signalEntities: [PODCAST], releaseDateMin: "2026-13-01" },
      { op: "insights", filterType: "urn:entity:person", signalEntities: [] },
      { op: "insights", filterType: "urn:entity:person", signalEntities: Array.from({ length: 26 }, (_, i) => `ID-${String(i).padStart(6, "0")}`) },
      { op: "trending", filterType: "urn:entity:person", entity: PERSON_A, startDate: "2026-10-18", endDate: "2026-07-27" },
      { op: "recommendations", query: "q" },
      "search",
      null,
    ];
    for (const op of rejected) {
      expect(badInputCode(op)).toBe("QLOO_BAD_INPUT");
    }
    expect(badInputCode({ op: "search", query: "q".repeat(300), types: ["urn:entity:podcast"], take: 50 })).toBeUndefined();
  });
});
