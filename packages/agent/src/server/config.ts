import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ServerError, type ServerConfigVariable } from "./errors.js";

export type ServerConfig = {
  production: boolean;
  port: number;
  appOrigin: string;
  databaseUrl: string | null;
  visitorHashSecret: string;
  turnstileSecret: string;
  clientIpHeader: string | null;
  runsPerVisitorPerDay: number;
  maxInflightRuns: number;
};

// Cloudflare's published Turnstile test secrets, from
// https://developers.cloudflare.com/turnstile/troubleshooting/testing/
// The always-pass one accepted any token in a live check on 19 Oct 2026, not
// only the dummy XXXX.DUMMY.TOKEN.XXXX, which is why production refuses them.
export const TURNSTILE_TEST_SECRET_ALWAYS_PASSES = "1x0000000000000000000000000000000AA";
export const TURNSTILE_TEST_SECRET_ALWAYS_FAILS = "2x0000000000000000000000000000000AA";
// Every published test secret has this shape (a digit, x, zeros, AA). One in
// production would quietly switch the human check off, so the shape is refused
// there rather than a list of the secrets known today.
const TURNSTILE_TEST_SECRET_SHAPE = /^\dx0+AA$/;

const REPO_ROOT_ENV_FILE = fileURLToPath(new URL("../../../../.env", import.meta.url));
const DEFAULT_PORT = 8787;
const DEV_APP_ORIGIN = "http://localhost:3000";
const DEFAULT_RUNS_PER_VISITOR_PER_DAY = 5;
const DEFAULT_MAX_INFLIGHT_RUNS = 3;
const MIN_SECRET_LENGTH = 32;

// One value for the life of the process, so every config load in it counts
// visitors under the same key.
let devVisitorHashSecret: string | undefined;

const blankToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);
const optionalText = z.preprocess(blankToUndefined, z.string().trim().optional());

const wholeNumber = (min: number, max: number) =>
  z
    .string()
    .regex(/^[0-9]{1,9}$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

const originSchema = (production: boolean) =>
  z.string().transform((text, ctx) => {
    const url = URL.parse(text);
    const allowed = url !== null && (url.protocol === "https:" || (!production && url.protocol === "http:"));
    if (!allowed) {
      ctx.addIssue({ code: "custom", message: "invalid origin" });
      return z.NEVER;
    }
    return url.origin;
  });

const databaseUrlSchema = z.string().refine((text) => {
  const url = URL.parse(text);
  return url !== null && (url.protocol === "postgres:" || url.protocol === "postgresql:") && url.hostname !== "";
});

const secretSchema = z.string().min(MIN_SECRET_LENGTH);

// Printable ASCII with no spaces, like every key Cloudflare issues.
const turnstileSecretSchema = z.string().regex(/^[\x21-\x7E]{1,2048}$/);

// The token grammar for a header field name in RFC 9110, section 5.6.2.
const headerNameSchema = z
  .string()
  .max(100)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/)
  .transform((name) => name.toLowerCase());

function parsed<T>(variable: ServerConfigVariable, schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ServerError("SRV_CONFIG", variable);
  return result.data;
}

/**
 * Reads and checks the agent server settings. When reading the real process
 * environment, the repo-root .env is loaded first if it exists, and values
 * already set win over the file; a custom `env` is read exactly as given.
 * Production (NODE_ENV=production) requires APP_ORIGIN over https,
 * DATABASE_URL, VISITOR_HASH_SECRET, TURNSTILE_SECRET_KEY and
 * CLIENT_IP_HEADER. In development these fall back to http://localhost:3000,
 * PGlite in memory (databaseUrl null), a random per-process secret with a
 * console warning, Cloudflare's always-pass test secret, and the socket
 * address. Throws ServerError("SRV_CONFIG") at the first bad or missing
 * variable; the message names the variable and never contains its value.
 */
export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  if (env === process.env && existsSync(REPO_ROOT_ENV_FILE)) {
    process.loadEnvFile(REPO_ROOT_ENV_FILE);
  }
  const production = env.NODE_ENV === "production";
  const text = (variable: ServerConfigVariable): string | undefined => parsed(variable, optionalText, env[variable]);
  const required = (variable: ServerConfigVariable): never => {
    throw new ServerError("SRV_CONFIG", variable);
  };

  const portText = text("PORT");
  const port = portText === undefined ? DEFAULT_PORT : parsed("PORT", wholeNumber(1, 65_535), portText);

  const originText = text("APP_ORIGIN") ?? (production ? required("APP_ORIGIN") : DEV_APP_ORIGIN);
  const appOrigin = parsed("APP_ORIGIN", originSchema(production), originText);

  const databaseText = text("DATABASE_URL");
  const databaseUrl =
    databaseText === undefined
      ? production
        ? required("DATABASE_URL")
        : null
      : parsed("DATABASE_URL", databaseUrlSchema, databaseText);

  const secretText = text("VISITOR_HASH_SECRET");
  let visitorHashSecret: string;
  if (secretText !== undefined) {
    visitorHashSecret = parsed("VISITOR_HASH_SECRET", secretSchema, secretText);
  } else if (production) {
    visitorHashSecret = required("VISITOR_HASH_SECRET");
  } else {
    devVisitorHashSecret ??= randomBytes(32).toString("hex");
    visitorHashSecret = devVisitorHashSecret;
    console.warn(
      "VISITOR_HASH_SECRET is not set, so this process uses a random one. Per-visitor counts start again after a restart.",
    );
  }

  const turnstileText = text("TURNSTILE_SECRET_KEY");
  const turnstileSecret =
    turnstileText === undefined
      ? production
        ? required("TURNSTILE_SECRET_KEY")
        : TURNSTILE_TEST_SECRET_ALWAYS_PASSES
      : parsed("TURNSTILE_SECRET_KEY", turnstileSecretSchema, turnstileText);
  if (production && TURNSTILE_TEST_SECRET_SHAPE.test(turnstileSecret)) required("TURNSTILE_SECRET_KEY");

  const headerText = text("CLIENT_IP_HEADER");
  const clientIpHeader =
    headerText === undefined
      ? production
        ? required("CLIENT_IP_HEADER")
        : null
      : parsed("CLIENT_IP_HEADER", headerNameSchema, headerText);

  const runsText = text("RUNS_PER_VISITOR_PER_DAY");
  const runsPerVisitorPerDay =
    runsText === undefined
      ? DEFAULT_RUNS_PER_VISITOR_PER_DAY
      : parsed("RUNS_PER_VISITOR_PER_DAY", wholeNumber(1, 100), runsText);

  const inflightText = text("MAX_INFLIGHT_RUNS");
  const maxInflightRuns =
    inflightText === undefined ? DEFAULT_MAX_INFLIGHT_RUNS : parsed("MAX_INFLIGHT_RUNS", wholeNumber(1, 20), inflightText);

  return {
    production,
    port,
    appOrigin,
    databaseUrl,
    visitorHashSecret,
    turnstileSecret,
    clientIpHeader,
    runsPerVisitorPerDay,
    maxInflightRuns,
  };
}
