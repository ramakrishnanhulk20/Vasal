import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

// Plugs into a running agent server the way any MCP agent would: the SDK's
// own client, with the agent key in the Authorization header and nowhere
// else. The key is read from the environment and never printed. Without
// --url it targets the local server on PORT.
const USAGE = "Usage: VASAL_AGENT_KEY=<agent key from POST /agent-keys> npx tsx scripts/mcp-smoke.ts [--url <base url>]";
const DEFAULT_PORT = "8787";

let urlText: string | undefined;
try {
  urlText = parseArgs({ options: { url: { type: "string" } }, strict: true, allowPositionals: false }).values.url;
} catch {
  console.error(USAGE);
  process.exit(2);
}
const base = URL.parse(urlText ?? `http://localhost:${process.env["PORT"]?.trim() || DEFAULT_PORT}`);
if (base === null || (base.protocol !== "https:" && base.protocol !== "http:")) {
  console.error(`--url must be an http or https address.\n${USAGE}`);
  process.exit(2);
}

const key = process.env["VASAL_AGENT_KEY"]?.trim() ?? "";
if (key === "") {
  console.error(`VASAL_AGENT_KEY is not set.\n${USAGE}`);
  process.exit(1);
}

// The SDK sends the key to this exact address: the base path plus mcp, with
// the query and fragment dropped so nothing in --url can ride along.
base.search = "";
base.hash = "";
const endpoint = new URL("mcp", base.pathname.endsWith("/") ? base : `${base.href}/`);
const client = new Client({ name: "vasal-mcp-smoke", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${key}` } } });

try {
  // The SDK declares sessionId as a getter returning string | undefined on
  // this class but as an optional string on Transport, which only clashes
  // under this repo's exactOptionalPropertyTypes. It is the SDK's own transport.
  await client.connect(transport as unknown as Transport);
  console.log(`Connected to ${endpoint.href}`);
  const { tools } = await client.listTools();
  console.log(`Tools: ${tools.map((tool) => tool.name).join(", ")}`);
  const result = await client.callTool({ name: "find_show", arguments: { query: "SmartLess" } });
  console.log(`find_show { "query": "SmartLess" } isError: ${result.isError === true}`);
  console.log(`find_show structuredContent: ${JSON.stringify(result.structuredContent, null, 2)}`);
} catch (error) {
  // The SDK's message names the HTTP status and the server's fixed refusal
  // body, never the request headers, so the key cannot appear in it.
  console.error(`The smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
