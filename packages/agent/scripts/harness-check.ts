// Starts Qloo's own MCP server exactly as the agent will, lists the tools
// Vasal allows, and asks qloo_capabilities for readiness. Works with no key,
// because qloo_capabilities never calls Qloo.
//
// Usage: npm run harness:check
import { z } from "zod";
import { loadQlooConfig, type QlooConfig } from "../src/config.js";
import { QlooError } from "../src/qloo/errors.js";
import { startHarness, type QlooHarness } from "../src/qloo/harness.js";

const CapabilitiesResult = z
  .object({
    structuredContent: z
      .object({
        manifest_schema_version: z.string(),
        contract_version: z.string(),
        contract_checksum: z.string(),
        result_schema_version: z.string(),
        adapter: z.object({ ready: z.boolean() }).passthrough(),
        operations: z.array(
          z.object({ id: z.string(), shared_tool_name: z.string(), summary: z.string().optional() }).passthrough(),
        ),
      })
      .passthrough(),
  })
  .passthrough();

const failureCode = (error: unknown) => (error instanceof QlooError ? error.code : "unexpected error");

async function main(): Promise<number> {
  let config: QlooConfig;
  try {
    config = loadQlooConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Qloo settings are invalid.");
    return 1;
  }

  console.log(`Starting qloo mcp for ${config.baseUrl.host}. Qloo key: ${config.apiKey === undefined ? "not set" : "set"}.`);
  let harness: QlooHarness;
  try {
    harness = await startHarness(config);
  } catch (error) {
    console.error(`Could not start qloo mcp (${failureCode(error)}).`);
    return 1;
  }

  try {
    const tools = await harness.listTools();
    console.log(`Allowed tools offered (${tools.length}):`);
    for (const tool of tools) console.log(`  ${tool.name}`);

    const capabilities = CapabilitiesResult.safeParse(await harness.callTool("qloo_capabilities", {}));
    if (!capabilities.success) {
      console.error("qloo_capabilities returned an unexpected shape.");
      return 1;
    }
    const result = capabilities.data.structuredContent;
    console.log("qloo_capabilities result:");
    console.log(`  contract ${result.contract_version}, checksum ${result.contract_checksum}`);
    console.log(`  manifest schema ${result.manifest_schema_version}, result schema ${result.result_schema_version}`);
    console.log(`  credential ${result.adapter.ready ? "ready, workflows will call Qloo" : "missing, workflows return QLOO_AUTH"}`);
    console.log("  adapter:");
    for (const line of JSON.stringify(result.adapter, null, 2).split("\n")) console.log(`    ${line}`);
    console.log("  operations:");
    for (const operation of result.operations) {
      console.log(`    ${operation.id} via ${operation.shared_tool_name}: ${operation.summary ?? ""}`.trimEnd());
    }
    console.log(`  (input and result schemas omitted: ${JSON.stringify(result).length} bytes in full)`);
    return 0;
  } catch (error) {
    console.error(`qloo mcp call failed (${failureCode(error)}).`);
    return 1;
  } finally {
    await harness.close();
  }
}

process.exitCode = await main();
