import { existsSync, readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { QlooConfig } from "../config.js";
import { QlooError } from "./errors.js";

/** The only harness tools Vasal may call. Anything else the server offers is hidden and refused. */
export const ALLOWED_HARNESS_TOOLS = [
  "qloo_find_tags",
  "qloo_describe",
  "qloo_recommend",
  "qloo_rank",
  "qloo_where_popular",
  "qloo_compare_audiences",
  "qloo_audience_demographics",
  "qloo_entity_tags",
  "qloo_trends",
  "qloo_capabilities",
] as const;

export type HarnessSpawnSpec = { command: string; args: string[]; env: Record<string, string> };

export type QlooHarness = {
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: unknown): Promise<unknown>;
  close(): Promise<void>;
};

/** The part of the MCP SDK Client that startHarness uses. Tests pass a stub. */
export type HarnessClient = {
  listTools(): Promise<{ tools: Tool[] }>;
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
};

export type HarnessConnector = (spec: HarnessSpawnSpec) => Promise<HarnessClient>;

const HARNESS_PACKAGE = "@qloo/qloo-harness";

// A private, git-ignored state folder for the harness. Without it the harness
// reads ~/.qloo/config, where a stored key, base URL or trust value from
// `qloo setup` would silently override what this process decided. Anything
// the harness writes (workflow logs) also stays out of the repo (C7.3).
const HARNESS_HOME = fileURLToPath(new URL("../../data/qloo-home", import.meta.url));

const ALLOWED = new Set<string>(ALLOWED_HARNESS_TOOLS);

const HarnessManifest = z.object({
  name: z.literal(HARNESS_PACKAGE),
  bin: z.union([z.string(), z.object({ qloo: z.string() })]),
});

// Resolved with Node's own package resolver from this file's location, so the
// version pinned in the lockfile is what runs. Nothing is fetched at run time.
function harnessBinPath(): string {
  const manifestPath = findPackageJSON(HARNESS_PACKAGE, import.meta.url);
  if (manifestPath === undefined) throw new Error(`${HARNESS_PACKAGE} is not installed. Run npm install.`);
  const manifest = HarnessManifest.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  const packageDir = dirname(manifestPath);
  const binPath = resolve(packageDir, typeof manifest.bin === "string" ? manifest.bin : manifest.bin.qloo);
  const insidePackage = relative(packageDir, binPath);
  if (!binPath.endsWith(".js") || insidePackage.startsWith("..") || isAbsolute(insidePackage) || !existsSync(binPath)) {
    throw new Error(`${HARNESS_PACKAGE} has no usable qloo bin file.`);
  }
  return binPath;
}

/**
 * How to start `qloo mcp`: the current Node binary running the harness's own
 * bin JS file, so no shell and no .cmd shim is involved (threat model C4.4).
 *
 * The environment holds only:
 * - QLOO_API_KEY, when a key is configured: the harness reads the key only here.
 * - QLOO_BASE_URL: the harness defaults to production, which refuses hackathon keys.
 * - QLOO_TRUSTED_BASE_URL: the same value. The harness sends a key to a
 *   non-production host only when this matches QLOO_BASE_URL exactly.
 * - QLOO_HOME: the harness's config and log root, pinned to a private folder.
 * - SystemRoot, on Windows only: without it Winsock cannot start, so the
 *   harness could make no network call at all.
 */
export function harnessSpawnSpec(cfg: QlooConfig): HarnessSpawnSpec {
  const env: Record<string, string> = {
    QLOO_BASE_URL: cfg.baseUrl.href,
    QLOO_TRUSTED_BASE_URL: cfg.baseUrl.href,
    QLOO_HOME: HARNESS_HOME,
  };
  if (cfg.apiKey !== undefined) env.QLOO_API_KEY = cfg.apiKey;
  const systemRoot = process.env.SystemRoot;
  if (process.platform === "win32" && systemRoot !== undefined) env.SystemRoot = systemRoot;
  return { command: process.execPath, args: [harnessBinPath(), "mcp"], env };
}

/**
 * The stdio transport for a spawn spec. Exported so a test can run the exact
 * spawn path with a different script and inspect what the child receives.
 *
 * The SDK spreads its own list of inherited variables (PATH, USERPROFILE and
 * more) under the env it is given. Each of those is overridden with undefined,
 * which Node's spawn drops, so the child gets only the spec's variables. On
 * Windows the OS layer still copies in a fixed set of base variables such as
 * PATH and TEMP; no spawn option can remove them.
 *
 * The child's stderr is discarded: it is third-party text and must not reach
 * our logs word for word (C3.6). A failed start still surfaces as a fixed code.
 */
export function createHarnessTransport(spec: HarnessSpawnSpec): StdioClientTransport {
  const ours = new Set(Object.keys(spec.env).map((name) => name.toUpperCase()));
  const dropped = Object.keys(getDefaultEnvironment())
    .filter((name) => !ours.has(name.toUpperCase()))
    .map((name) => [name, undefined]);
  const env = { ...Object.fromEntries(dropped), ...spec.env } as Record<string, string>;
  return new StdioClientTransport({ command: spec.command, args: spec.args, env, stderr: "ignore" });
}

async function connectOverStdio(spec: HarnessSpawnSpec): Promise<HarnessClient> {
  const transport = createHarnessTransport(spec);
  const client = new Client({ name: "vasal-agent", version: "0.1.0" });
  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  }
  return client;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

const mcpFailure = (error: unknown) =>
  new QlooError(error instanceof McpError && error.code === ErrorCode.RequestTimeout ? "QLOO_TIMEOUT" : "QLOO_UPSTREAM");

/**
 * Starts Qloo's own MCP server (`qloo mcp`) as a child process and connects
 * to it with the MCP SDK.
 *
 * listTools returns only tools on ALLOWED_HARNESS_TOOLS, even if a package
 * update adds more. callTool throws QlooError("QLOO_BAD_INPUT") for a name off
 * that list, or for arguments that are not a plain object, without contacting
 * the server (threat model C2.2). Requests use the SDK's 60 second timeout.
 * Failures become QLOO_TIMEOUT or QLOO_UPSTREAM; server text is never passed on.
 *
 * `connect` exists for tests; production code never passes it.
 */
export async function startHarness(cfg: QlooConfig, connect: HarnessConnector = connectOverStdio): Promise<QlooHarness> {
  const spec = harnessSpawnSpec(cfg);
  let client: HarnessClient;
  try {
    client = await connect(spec);
  } catch {
    throw new QlooError("QLOO_UPSTREAM");
  }

  return {
    async listTools() {
      try {
        const { tools } = await client.listTools();
        return tools.filter((tool) => ALLOWED.has(tool.name));
      } catch (error) {
        throw mcpFailure(error);
      }
    },
    async callTool(name, args) {
      if (!ALLOWED.has(name) || !isPlainObject(args)) throw new QlooError("QLOO_BAD_INPUT");
      try {
        return await client.callTool({ name, arguments: args });
      } catch (error) {
        throw mcpFailure(error);
      }
    },
    close: () => client.close(),
  };
}
