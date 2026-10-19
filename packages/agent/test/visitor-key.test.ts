// Covers the visitor key normaliser and hash. It does not cover which header
// the address is read from, whether the hosting edge lets a client spoof it,
// or the per-visitor counting and pruning built on top of the key.
import { describe, expect, it } from "vitest";
import { visitorKey } from "../src/net/visitor-key.js";

const SECRET = "s".repeat(32);
const OTHER_SECRET = "t".repeat(32);

function keyOf(address: string, secret = SECRET): string {
  const key = visitorKey(address, secret);
  if (key === null) throw new Error("expected a key");
  return key;
}

describe("visitorKey", () => {
  it("gives one key for an IPv4 address and its IPv4-mapped IPv6 forms (C5.3)", () => {
    const plain = keyOf("1.2.3.4");

    expect(keyOf("::ffff:1.2.3.4")).toBe(plain);
    expect(keyOf("::ffff:102:304")).toBe(plain);
    expect(keyOf(" 1.2.3.4 ")).toBe(plain);
    expect(keyOf("1.2.3.5")).not.toBe(plain);
  });

  it("gives one key per IPv6 /64 and different keys for different /64s", () => {
    const low = keyOf("2001:db8:1:2::1");

    expect(keyOf("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe(low);
    expect(keyOf("2001:0db8:0001:0002:0000:0000:0000:0abc")).toBe(low);
    expect(keyOf("2001:db8:1:3::1")).not.toBe(low);
    expect(keyOf("2001:db8:2:2::1")).not.toBe(low);
  });

  it("gives different keys under different secrets", () => {
    expect(keyOf("1.2.3.4", OTHER_SECRET)).not.toBe(keyOf("1.2.3.4"));
    expect(keyOf("2001:db8:1:2::1", OTHER_SECRET)).not.toBe(keyOf("2001:db8:1:2::1"));
  });

  it("returns null for anything that is not one address", () => {
    for (const garbage of [
      "",
      "not an ip",
      "1.2.3.4.5",
      "300.1.1.1",
      "1.2.3.4, 5.6.7.8",
      "1.2.3.4/24",
      "2001:db8::g",
      "1".repeat(101),
    ]) {
      expect(visitorKey(garbage, SECRET)).toBeNull();
    }
  });

  it("returns null for a secret shorter than 32 characters", () => {
    expect(visitorKey("1.2.3.4", "s".repeat(31))).toBeNull();
    expect(visitorKey("1.2.3.4", "")).toBeNull();
    expect(visitorKey("1.2.3.4", "s".repeat(32))).not.toBeNull();
  });

  it("never contains the raw address (C6.8)", () => {
    for (const address of ["1.2.3.4", "::ffff:1.2.3.4", "203.0.113.77", "2001:db8:1:2::1"]) {
      const key = keyOf(address);
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(key).not.toContain(address);
    }
  });
});
