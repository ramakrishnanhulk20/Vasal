// Covers how `qloo mcp` is started, what environment the child receives, the
// tool allowlist, and a no-key start of the real harness. It does not cover any
// harness tool that calls Qloo (that needs a key and runs in the probe), nor
// the harness's own behaviour beyond the tool list and qloo_capabilities.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { ErrorCode, McpError, type JSONRPCMessage, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QlooConfig } from "../src/config.js";
import { QlooError } from "../src/qloo/errors.js";
import {
  ALLOWED_HARNESS_TOOLS,
  createHarnessTransport,
  harnessSpawnSpec,
  startHarness,
  type HarnessClient,
} from "../src/qloo/harness.js";

const FAKE_KEY = "FAKE-KEY-harness-test-91c2";
const WITH_KEY: QlooConfig = { apiKey: FAKE_KEY, baseUrl: new URL("https://hackathon.api.qloo.com") };
const NO_KEY: QlooConfig = { apiKey: undefined, baseUrl: new URL("https://hackathon.api.qloo.com") };
const WINDOWS_EXTRA = process.platform === "win32" ? ["SystemRoot"] : [];
const CANARY = "VASAL_TEST_CANARY";

const listChildEnv = "process.stdout.write(JSON.stringify(Object.keys(process.env)))";
const reportChildEnv =
  "process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/env-report',params:{keys:Object.keys(process.env),ppid:process.ppid,apiKey:process.env.QLOO_API_KEY}})+'\\n')";

// Windows env names are case-insensitive, and the OS layer may report a name
// in a different case than we set it, so compare them folded there.
const foldNames = (names: string[]) =>
  [...new Set(names.map((name) => (process.platform === "win32" ? name.toUpperCase() : name)))].sort();

// Measured, not listed: whatever the OS adds to a child started with an empty
// environment is the floor no spawn option can remove.
function osForcedVariables(): string[] {
  const child = spawnSync(process.execPath, ["-e", listChildEnv], { env: {}, encoding: "utf8" });
  return JSON.parse(child.stdout) as string[];
}

function stubClient(toolNames: string[]) {
  const callTool = vi.fn(async (_params: { name: string; arguments: Record<string, unknown> }) => ({ content: [] }));
  const listTools = vi.fn(async () => ({
    tools: toolNames.map((name): Tool => ({ name, inputSchema: { type: "object" } })),
  }));
  const close = vi.fn(async () => undefined);
  const client: HarnessClient = { callTool, listTools, close };
  return { client, callTool, listTools };
}

afterEach(() => {
  delete process.env[CANARY];
});

describe("harnessSpawnSpec", () => {
  it("gives the child exactly the expected environment keys (C4.4)", () => {
    const withKey = harnessSpawnSpec(WITH_KEY);
    expect(Object.keys(withKey.env).sort()).toEqual(
      ["QLOO_API_KEY", "QLOO_BASE_URL", "QLOO_HOME", "QLOO_TRUSTED_BASE_URL", ...WINDOWS_EXTRA].sort(),
    );
    expect(withKey.env.QLOO_API_KEY).toBe(FAKE_KEY);
    expect(withKey.env.QLOO_BASE_URL).toBe("https://hackathon.api.qloo.com/");
    expect(withKey.env.QLOO_TRUSTED_BASE_URL).toBe(withKey.env.QLOO_BASE_URL);
    expect(isAbsolute(withKey.env.QLOO_HOME ?? "")).toBe(true);
    expect((withKey.env.QLOO_HOME ?? "").replaceAll("\\", "/")).toMatch(/\/packages\/agent\/data\/qloo-home$/);

    const noKey = harnessSpawnSpec(NO_KEY);
    expect(Object.keys(noKey.env).sort()).toEqual(
      ["QLOO_BASE_URL", "QLOO_HOME", "QLOO_TRUSTED_BASE_URL", ...WINDOWS_EXTRA].sort(),
    );
  });

  it("runs the pinned harness bin JS with the current Node binary and has no shell option (C4.4)", () => {
    const spec = harnessSpawnSpec(NO_KEY);

    expect(spec.command).toBe(process.execPath);
    expect(spec.args).toHaveLength(2);
    expect(spec.args[1]).toBe("mcp");
    const bin = spec.args[0] ?? "";
    expect(isAbsolute(bin)).toBe(true);
    expect(bin.endsWith(".js")).toBe(true);
    expect(existsSync(bin)).toBe(true);
    expect(bin.replaceAll("\\", "/")).toContain("/node_modules/@qloo/qloo-harness/");
    expect(Object.keys(spec)).toEqual(["command", "args", "env"]);
    expect("shell" in spec).toBe(false);
  });
});

describe("createHarnessTransport", () => {
  it("starts the child directly, with only the spec's variables plus what the OS forces, and none of ours (C4.4)", async () => {
    process.env[CANARY] = "canary-secret-must-not-reach-the-child";
    const spec = harnessSpawnSpec(WITH_KEY);
    const transport = createHarnessTransport({ ...spec, args: ["-e", reportChildEnv] });
    const report = new Promise<{ keys: string[]; ppid: number; apiKey?: string }>((resolve, reject) => {
      transport.onmessage = (message: JSONRPCMessage) => {
        resolve((message as unknown as { params: { keys: string[]; ppid: number; apiKey?: string } }).params);
      };
      transport.onerror = reject;
    });

    await transport.start();
    const child = await report;
    await transport.close();

    expect(foldNames(child.keys)).toEqual(foldNames([...Object.keys(spec.env), ...osForcedVariables()]));
    expect(child.keys).not.toContain(CANARY);
    expect(child.apiKey).toBe(FAKE_KEY);
    // A shell between us and the child would be the child's parent instead.
    expect(child.ppid).toBe(process.pid);
  });
});

describe("startHarness", () => {
  it("refuses a tool name off the allowlist without sending anything (C2.2)", async () => {
    const stub = stubClient([...ALLOWED_HARNESS_TOOLS]);
    const harness = await startHarness(NO_KEY, async () => stub.client);

    for (const name of ["qloo_shell_exec", "QLOO_RECOMMEND", "qloo_recommend ", "__proto__", "toString", ""]) {
      await expect(harness.callTool(name, {})).rejects.toMatchObject({ code: "QLOO_BAD_INPUT" });
    }
    for (const args of [null, "text", ["array"], 42, new Date()]) {
      await expect(harness.callTool("qloo_recommend", args)).rejects.toMatchObject({ code: "QLOO_BAD_INPUT" });
    }
    expect(stub.callTool).not.toHaveBeenCalled();
    expect(stub.listTools).not.toHaveBeenCalled();
  });

  it("forwards an allowed call unchanged and hides tools the server adds beyond the list", async () => {
    const stub = stubClient(["qloo_capabilities", "qloo_recommend", "qloo_api_shell", "qloo_future_tool"]);
    const harness = await startHarness(NO_KEY, async () => stub.client);

    expect((await harness.listTools()).map((tool) => tool.name)).toEqual(["qloo_capabilities", "qloo_recommend"]);
    await harness.callTool("qloo_recommend", { target_type: "person", signals: ["Synthetic Show"], limit: 3 });
    expect(stub.callTool).toHaveBeenCalledWith({
      name: "qloo_recommend",
      arguments: { target_type: "person", signals: ["Synthetic Show"], limit: 3 },
    });
  });

  it("turns MCP failures into fixed codes that carry no server text (C3.6)", async () => {
    const stub = stubClient(["qloo_recommend"]);
    stub.callTool.mockRejectedValueOnce(new McpError(ErrorCode.RequestTimeout, "timed out"));
    stub.callTool.mockRejectedValueOnce(new Error(`server said ${FAKE_KEY}`));
    const harness = await startHarness(NO_KEY, async () => stub.client);

    await expect(harness.callTool("qloo_recommend", {})).rejects.toMatchObject({ code: "QLOO_TIMEOUT" });
    const failure = await harness.callTool("qloo_recommend", {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(QlooError);
    expect((failure as QlooError).code).toBe("QLOO_UPSTREAM");
    expect(String(failure)).not.toContain(FAKE_KEY);

    await expect(
      startHarness(NO_KEY, async () => {
        throw new Error(`spawn failed ${FAKE_KEY}`);
      }),
    ).rejects.toMatchObject({ code: "QLOO_UPSTREAM", message: "Qloo request failed." });
  });

  it("starts the real qloo mcp with no key, lists the allowed tools and reports readiness offline", async () => {
    const harness = await startHarness(NO_KEY);
    try {
      const names = (await harness.listTools()).map((tool) => tool.name).sort();
      expect(names).toEqual([...ALLOWED_HARNESS_TOOLS].sort());

      const capabilities = (await harness.callTool("qloo_capabilities", {})) as {
        structuredContent?: { adapter?: { ready?: boolean }; contract_checksum?: string };
      };
      expect(capabilities.structuredContent?.adapter?.ready).toBe(false);
      expect(capabilities.structuredContent?.contract_checksum).toMatch(/^sha256:[a-f0-9]{64}$/);
    } finally {
      await harness.close();
    }
  });
});
