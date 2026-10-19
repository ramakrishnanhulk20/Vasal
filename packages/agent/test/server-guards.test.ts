// Covers the POST origin and content type check and the choice of client
// address. It does not cover how a route reads the headers from a request,
// whether the configured header is one the hosting edge really sets and
// clients cannot, or CORS response headers.
import { describe, expect, it } from "vitest";
import { clientAddressFrom, isAllowedPost } from "../src/server/guards.js";

const APP = "https://app.example";
const JSON_TYPE = "application/json";

describe("isAllowedPost (C5.5)", () => {
  it("accepts the exact origin with JSON, including a charset parameter", () => {
    expect(isAllowedPost({ origin: APP, contentType: JSON_TYPE }, APP)).toBe(true);
    expect(isAllowedPost({ origin: APP, contentType: "application/json; charset=utf-8" }, APP)).toBe(true);
    expect(isAllowedPost({ origin: APP, contentType: " Application/JSON ;charset=utf-8" }, APP)).toBe(true);
  });

  it("accepts an app origin given with a trailing slash in config", () => {
    expect(isAllowedPost({ origin: APP, contentType: JSON_TYPE }, `${APP}/`)).toBe(true);
    expect(isAllowedPost({ origin: "https://APP.example", contentType: JSON_TYPE }, `${APP}/`)).toBe(true);
  });

  it("refuses other origins", () => {
    for (const origin of [
      "https://evil.example",
      "http://app.example",
      "https://app.example:8443",
      "https://app.example.evil.example",
      "https://evil.example/https://app.example",
    ]) {
      expect(isAllowedPost({ origin, contentType: JSON_TYPE }, APP)).toBe(false);
    }
  });

  it("refuses a missing, empty, null or unparseable Origin", () => {
    for (const origin of [null, "", "null", "app.example", "not a url", "file:///etc/passwd"]) {
      expect(isAllowedPost({ origin, contentType: JSON_TYPE }, APP)).toBe(false);
    }
    expect(isAllowedPost({ contentType: JSON_TYPE }, APP)).toBe(false);
  });

  it("refuses content types a cross-site form can send without asking, and near misses", () => {
    for (const contentType of [
      "text/plain",
      "multipart/form-data; boundary=x",
      "application/x-www-form-urlencoded",
      "application/json-patch+json",
      "application/jsonx",
      "text/plain; application/json",
      "application/json, text/plain",
      "",
      null,
    ]) {
      expect(isAllowedPost({ origin: APP, contentType }, APP)).toBe(false);
    }
    expect(isAllowedPost({ origin: APP }, APP)).toBe(false);
  });

  it("refuses everything when the configured origin itself does not parse to a real origin", () => {
    expect(isAllowedPost({ origin: "null", contentType: JSON_TYPE }, "null")).toBe(false);
    expect(isAllowedPost({ origin: "file:///a", contentType: JSON_TYPE }, "file:///b")).toBe(false);
    expect(isAllowedPost({ origin: APP, contentType: JSON_TYPE }, "")).toBe(false);
  });
});

describe("clientAddressFrom (C5.3)", () => {
  const HEADER = "fly-client-ip";

  it("uses only the configured header's single address", () => {
    expect(clientAddressFrom("203.0.113.9", "10.0.0.1", HEADER)).toBe("203.0.113.9");
    expect(clientAddressFrom("2001:db8::1", "10.0.0.1", HEADER)).toBe("2001:db8::1");
    expect(clientAddressFrom("::ffff:203.0.113.9", null, HEADER)).toBe("::ffff:203.0.113.9");
  });

  it("gives null for a list, garbage, an empty value or a missing header, never the socket", () => {
    for (const value of [
      "203.0.113.9, 10.0.0.1",
      "203.0.113.9,10.0.0.1",
      "203.0.113.9 ",
      " 203.0.113.9",
      "203.0.113.9\t",
      "unknown",
      "not-an-ip",
      "<script>",
      "",
      "1".repeat(101),
      null,
      undefined,
    ]) {
      expect(clientAddressFrom(value, "198.51.100.7", HEADER)).toBeNull();
    }
  });

  it("uses the socket address only when no header is configured", () => {
    expect(clientAddressFrom("203.0.113.9", "198.51.100.7", null)).toBe("198.51.100.7");
    expect(clientAddressFrom(undefined, "::1", null)).toBe("::1");
    expect(clientAddressFrom("203.0.113.9", undefined, null)).toBeNull();
    expect(clientAddressFrom("203.0.113.9", "garbage", null)).toBeNull();
  });
});
