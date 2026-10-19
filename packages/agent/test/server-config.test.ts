// Covers reading and checking the agent server settings from an env object.
// It does not cover loading the repo-root .env file (only done for the real
// process.env), whether the configured client IP header is one the host
// really sets, or whether the secrets are the operator's real ones.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TURNSTILE_TEST_SECRET_ALWAYS_FAILS,
  TURNSTILE_TEST_SECRET_ALWAYS_PASSES,
  loadServerConfig,
} from "../src/server/config.js";
import { ServerError } from "../src/server/errors.js";

const MARKER = "MARKER-c0f1a7";

const PRODUCTION: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  PORT: "8080",
  APP_ORIGIN: "https://app.example/",
  DATABASE_URL: `postgresql://vasal_app:${MARKER}@db.example/vasal`,
  VISITOR_HASH_SECRET: `${MARKER}-${"v".repeat(32)}`,
  TURNSTILE_SECRET_KEY: `0x4AAAAAAA${MARKER}`,
  CLIENT_IP_HEADER: "Fly-Client-IP",
  RUNS_PER_VISITOR_PER_DAY: "7",
  MAX_INFLIGHT_RUNS: "4",
};

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

function configError(env: NodeJS.ProcessEnv): ServerError {
  try {
    loadServerConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ServerError);
    return error as ServerError;
  }
  throw new Error("expected loadServerConfig to throw");
}

function expectRefusal(env: NodeJS.ProcessEnv, variable: string): void {
  const error = configError(env);
  expect(error.code).toBe("SRV_CONFIG");
  expect(error.message).toContain(variable);
  expect(error.message).not.toContain("MARKER");
  expect(JSON.stringify(error)).not.toContain("MARKER");
  for (const value of Object.values(env)) {
    if (value !== undefined && value.length > 3 && value !== "production") expect(error.message).not.toContain(value);
  }
}

describe("loadServerConfig in development", () => {
  it("works with an empty env", () => {
    const config = loadServerConfig({});

    expect(config).toMatchObject({
      production: false,
      port: 8787,
      appOrigin: "http://localhost:3000",
      databaseUrl: null,
      turnstileSecret: TURNSTILE_TEST_SECRET_ALWAYS_PASSES,
      clientIpHeader: null,
      runsPerVisitorPerDay: 5,
      maxInflightRuns: 3,
    });
    expect(config.visitorHashSecret.length).toBeGreaterThanOrEqual(32);
    expect(loadServerConfig({}).visitorHashSecret).toBe(config.visitorHashSecret);

    expect(warn).toHaveBeenCalled();
    for (const call of warn.mock.calls) {
      expect(call.join(" ")).toContain("VISITOR_HASH_SECRET");
      expect(call.join(" ")).not.toContain(config.visitorHashSecret);
    }
  });

  it("treats blank values as unset and allows an http origin", () => {
    const config = loadServerConfig({ PORT: " ", APP_ORIGIN: "http://127.0.0.1:3000/", MAX_INFLIGHT_RUNS: "" });

    expect(config.port).toBe(8787);
    expect(config.appOrigin).toBe("http://127.0.0.1:3000");
    expect(config.maxInflightRuns).toBe(3);
  });

  it("names the published test secrets", () => {
    expect(TURNSTILE_TEST_SECRET_ALWAYS_PASSES).toBe("1x0000000000000000000000000000000AA");
    expect(TURNSTILE_TEST_SECRET_ALWAYS_FAILS).toBe("2x0000000000000000000000000000000AA");
  });

  it("does not load the .env file for a custom env", () => {
    const load = vi.spyOn(process, "loadEnvFile");
    loadServerConfig({});
    expect(load).not.toHaveBeenCalled();
    load.mockRestore();
  });
});

describe("loadServerConfig in production", () => {
  it("reads a complete production env", () => {
    expect(loadServerConfig(PRODUCTION)).toEqual({
      production: true,
      port: 8080,
      appOrigin: "https://app.example",
      databaseUrl: PRODUCTION.DATABASE_URL,
      visitorHashSecret: PRODUCTION.VISITOR_HASH_SECRET,
      turnstileSecret: PRODUCTION.TURNSTILE_SECRET_KEY,
      clientIpHeader: "fly-client-ip",
      runsPerVisitorPerDay: 7,
      maxInflightRuns: 4,
      anthropicApiKey: null,
      model: "claude-haiku-5-5",
      effort: "medium",
      anthropicTokensPerDay: 2_000_000,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("refuses to start without each required variable, naming it and not its value", () => {
    for (const variable of ["DATABASE_URL", "CLIENT_IP_HEADER", "TURNSTILE_SECRET_KEY", "VISITOR_HASH_SECRET", "APP_ORIGIN"]) {
      expectRefusal({ ...PRODUCTION, [variable]: undefined }, variable);
      expectRefusal({ ...PRODUCTION, [variable]: "   " }, variable);
    }
  });

  it("refuses an http APP_ORIGIN", () => {
    expectRefusal({ ...PRODUCTION, APP_ORIGIN: "http://app.example" }, "APP_ORIGIN");
  });

  it("refuses Cloudflare's test secrets, which would switch the human check off", () => {
    for (const secret of [
      TURNSTILE_TEST_SECRET_ALWAYS_PASSES,
      TURNSTILE_TEST_SECRET_ALWAYS_FAILS,
      "3x0000000000000000000000000000000AA",
    ]) {
      expectRefusal({ ...PRODUCTION, TURNSTILE_SECRET_KEY: secret }, "TURNSTILE_SECRET_KEY");
    }
  });
});

describe("loadServerConfig with bad values", () => {
  it("refuses each bad value, naming the variable and not the value", () => {
    const cases: Array<[string, string]> = [
      ["PORT", "0"],
      ["PORT", "65536"],
      ["PORT", `80${MARKER}`],
      ["PORT", "1e3"],
      ["PORT", "-1"],
      ["APP_ORIGIN", `ftp://${MARKER}.example`],
      ["APP_ORIGIN", `javascript:${MARKER}`],
      ["APP_ORIGIN", `not a url ${MARKER}`],
      ["DATABASE_URL", `mysql://user:${MARKER}@db.example/x`],
      ["DATABASE_URL", `${MARKER}`],
      ["VISITOR_HASH_SECRET", `${MARKER}-short`],
      ["TURNSTILE_SECRET_KEY", `has space ${MARKER}`],
      ["CLIENT_IP_HEADER", `x-forwarded-for, ${MARKER}`],
      ["CLIENT_IP_HEADER", `bad:header${MARKER}`],
      ["RUNS_PER_VISITOR_PER_DAY", "0"],
      ["RUNS_PER_VISITOR_PER_DAY", "101"],
      ["RUNS_PER_VISITOR_PER_DAY", `five${MARKER}`],
      ["MAX_INFLIGHT_RUNS", "0"],
      ["MAX_INFLIGHT_RUNS", "21"],
      ["ANTHROPIC_API_KEY", `sk-ant ${MARKER}`],
      ["VASAL_MODEL", `gpt-${MARKER}`],
      ["VASAL_MODEL", "claude-HAIKU"],
      ["VASAL_EFFORT", `max${MARKER}`],
      ["ANTHROPIC_TOKENS_PER_DAY", "0"],
      ["ANTHROPIC_TOKENS_PER_DAY", `2e6${MARKER}`],
    ];
    for (const [variable, value] of cases) {
      expectRefusal({ ...PRODUCTION, [variable]: value }, variable);
      expectRefusal({ [variable]: value }, variable);
    }
  });
});
