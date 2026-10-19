import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export type QlooConfig = { apiKey: string | undefined; baseUrl: URL };

const DEFAULT_QLOO_BASE_URL = "https://hackathon.api.qloo.com";
const REPO_ROOT_ENV_FILE = fileURLToPath(new URL("../../../.env", import.meta.url));

// Hackathon keys answer 401 on these hosts, so pointing at them is always a
// mistake. This is a usability guard, not a security boundary.
const HOSTS_THAT_REFUSE_HACKATHON_KEYS = new Set(["api.qloo.com", "staging.api.qloo.com"]);

const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

// Printable ASCII only: a header value with a space, a line break or a
// non-Latin-1 character would make fetch throw before anything is sent.
const ApiKeySchema = z.preprocess(
  blankToUndefined,
  z.string().trim().regex(/^[\x21-\x7E]+$/).optional(),
);

const BaseUrlSchema = z.preprocess(
  blankToUndefined,
  z
    .string()
    .trim()
    .default(DEFAULT_QLOO_BASE_URL)
    .transform((text, ctx) => {
      const url = URL.parse(text);
      // The request builder joins fixed paths onto the origin, so a base path,
      // query, fragment or user info would be silently dropped. Refuse instead.
      const isPlainHttpsOrigin =
        url !== null &&
        url.protocol === "https:" &&
        url.username === "" &&
        url.password === "" &&
        url.pathname === "/" &&
        url.search === "" &&
        url.hash === "";
      if (!isPlainHttpsOrigin || HOSTS_THAT_REFUSE_HACKATHON_KEYS.has(url.hostname.replace(/\.$/, ""))) {
        ctx.addIssue({ code: "custom", message: "invalid base URL" });
        return z.NEVER;
      }
      return new URL(url.origin);
    }),
);

const QlooEnvSchema = z.object({
  QLOO_API_KEY: ApiKeySchema,
  QLOO_BASE_URL: BaseUrlSchema,
});

const FIXED_MESSAGES: Record<keyof z.infer<typeof QlooEnvSchema>, string> = {
  QLOO_API_KEY: "QLOO_API_KEY has spaces or characters a key cannot contain. Copy the key into .env again.",
  QLOO_BASE_URL:
    "QLOO_BASE_URL must be a plain https origin such as https://hackathon.api.qloo.com. Hackathon keys are refused by api.qloo.com and staging.api.qloo.com.",
};

/**
 * Reads the Qloo settings from the environment.
 *
 * When reading the real process environment, the repo-root `.env` is loaded
 * first if it exists. Values already set in the environment win over the file.
 * A custom `env` object is read as given, so tests never touch `process.env`.
 *
 * Throws an Error with a fixed message naming the bad variable. The message
 * never contains the value, so a malformed key is not echoed to a log.
 */
export function loadQlooConfig(env: NodeJS.ProcessEnv = process.env): QlooConfig {
  if (env === process.env && existsSync(REPO_ROOT_ENV_FILE)) {
    process.loadEnvFile(REPO_ROOT_ENV_FILE);
  }
  const parsed = QlooEnvSchema.safeParse({
    QLOO_API_KEY: env.QLOO_API_KEY,
    QLOO_BASE_URL: env.QLOO_BASE_URL,
  });
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    throw new Error(field === "QLOO_API_KEY" ? FIXED_MESSAGES.QLOO_API_KEY : FIXED_MESSAGES.QLOO_BASE_URL);
  }
  return { apiKey: parsed.data.QLOO_API_KEY, baseUrl: parsed.data.QLOO_BASE_URL };
}
