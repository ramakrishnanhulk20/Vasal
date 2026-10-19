export type ServerErrorCode = "SRV_BAD_INPUT" | "SRV_NOT_FOUND" | "SRV_LIMIT" | "SRV_UNAVAILABLE" | "SRV_CONFIG";

export type ServerConfigVariable =
  | "PORT"
  | "APP_ORIGIN"
  | "DATABASE_URL"
  | "VISITOR_HASH_SECRET"
  | "TURNSTILE_SECRET_KEY"
  | "CLIENT_IP_HEADER"
  | "RUNS_PER_VISITOR_PER_DAY"
  | "MAX_INFLIGHT_RUNS";

// Every message is fixed text. Inputs, driver errors and environment values
// are attacker or operator data that must never reach a response or a log
// line by way of an error (C3.6, C4.1).
const MESSAGES: Record<ServerErrorCode, string> = {
  SRV_BAD_INPUT: "The server refused an input outside its limits.",
  SRV_NOT_FOUND: "The requested item does not exist.",
  SRV_LIMIT: "A server limit was reached.",
  SRV_UNAVAILABLE: "The server could not complete the request.",
  SRV_CONFIG: "The server configuration is invalid.",
};

const CONFIG_MESSAGES: Record<ServerConfigVariable, string> = {
  PORT: "PORT must be a whole number from 1 to 65535.",
  APP_ORIGIN: "APP_ORIGIN must be the web app's http or https origin, and https in production.",
  DATABASE_URL: "DATABASE_URL must be a postgres:// connection string. It is required in production.",
  VISITOR_HASH_SECRET: "VISITOR_HASH_SECRET must be at least 32 characters. It is required in production.",
  TURNSTILE_SECRET_KEY:
    "TURNSTILE_SECRET_KEY must be the Turnstile secret key, with no spaces. It is required in production.",
  CLIENT_IP_HEADER:
    "CLIENT_IP_HEADER must be the one header name the hosting edge sets to the client address. It is required in production.",
  RUNS_PER_VISITOR_PER_DAY: "RUNS_PER_VISITOR_PER_DAY must be a whole number from 1 to 100.",
  MAX_INFLIGHT_RUNS: "MAX_INFLIGHT_RUNS must be a whole number from 1 to 20.",
};

/**
 * The only error type the server modules throw. Its message is chosen from a
 * fixed table by code, and for SRV_CONFIG by the name of the bad variable, so
 * no value ever travels inside it. It never carries a `cause`.
 */
export class ServerError extends Error {
  override readonly name = "ServerError";
  readonly code: ServerErrorCode;

  constructor(code: ServerErrorCode, variable?: ServerConfigVariable) {
    super(
      code === "SRV_CONFIG" && variable !== undefined && Object.hasOwn(CONFIG_MESSAGES, variable)
        ? CONFIG_MESSAGES[variable]
        : MESSAGES[code],
    );
    this.code = code;
  }
}
