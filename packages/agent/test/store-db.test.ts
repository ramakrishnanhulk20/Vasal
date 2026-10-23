// Covers the TLS rule poolConfigFrom picks for each host and network. It does
// not open a connection, so it does not show that Railway's private network
// really is encrypted, or that a hosted server accepts the settings.
import { describe, expect, it } from "vitest";
import { createPgDb, poolConfigFrom } from "../src/store/db.js";
import { StoreError } from "../src/store/errors.js";

const VERIFIED = { rejectUnauthorized: true };
const url = (host: string, query = "") => `postgresql://vasal_app:pw@${host}:5432/railway${query}`;

describe("poolConfigFrom TLS", () => {
  it("turns TLS off for a .railway.internal host only when railway-private is named", () => {
    expect(poolConfigFrom(url("postgres.railway.internal"), "railway-private").ssl).toBe(false);
    expect(poolConfigFrom(url("db-7f3a.railway.internal"), "railway-private").ssl).toBe(false);
  });

  it("keeps verified TLS for every other host on railway-private", () => {
    for (const host of [
      "db.example.com",
      "postgres.railway.internal.evil.example",
      "railway.internal",
      "xrailway.internal",
      "postgres.railway.internal.",
      "roundhouse.proxy.rlwy.net",
      "[fd12::1]",
      "10.0.0.5",
    ]) {
      expect(poolConfigFrom(url(host), "railway-private").ssl, host).toEqual(VERIFIED);
    }
  });

  it("keeps verified TLS for a .railway.internal host when no network is named", () => {
    expect(poolConfigFrom(url("postgres.railway.internal")).ssl).toEqual(VERIFIED);
  });

  it("never reads the network or the TLS mode from the URL", () => {
    for (const query of ["?sslmode=disable", "?network=railway-private", "?ssl=false&sslmode=no-verify"]) {
      expect(poolConfigFrom(url("postgres.railway.internal", query)).ssl, query).toEqual(VERIFIED);
      expect(poolConfigFrom(url("db.example.com", query), "railway-private").ssl, query).toEqual(VERIFIED);
    }
  });

  it("keeps loopback without TLS whatever the network", () => {
    expect(poolConfigFrom(url("localhost")).ssl).toBe(false);
    expect(poolConfigFrom(url("127.0.0.1"), "railway-private").ssl).toBe(false);
    expect(poolConfigFrom(url("[::1]")).ssl).toBe(false);
  });

  it("refuses a URL with no user, so pg can never fill one in from PGUSER", () => {
    const saved = process.env["PGUSER"];
    process.env["PGUSER"] = "postgres";
    try {
      expect(() => poolConfigFrom("postgresql://:pw@db.example.com:5432/app")).toThrow(StoreError);
      expect(() => poolConfigFrom("postgresql://db.example.com:5432/app")).toThrow(StoreError);
      expect(poolConfigFrom("postgresql://vasal_app:pw@db.example.com:5432/app").user).toBe("vasal_app");
    } finally {
      if (saved === undefined) delete process.env["PGUSER"];
      else process.env["PGUSER"] = saved;
    }
  });

  it("refuses a network it does not know, without repeating the URL", () => {
    const secretUrl = url("postgres.railway.internal").replace("pw", "MARKER-91c2");
    for (const run of [
      () => poolConfigFrom(secretUrl, "railway-public" as never),
      () => createPgDb(secretUrl, { network: "RAILWAY-PRIVATE" as never }),
    ]) {
      expect(run).toThrow(StoreError);
      try {
        run();
      } catch (error) {
        expect((error as StoreError).code).toBe("STORE_BAD_INPUT");
        expect((error as Error).message).not.toContain("MARKER");
      }
    }
  });
});
