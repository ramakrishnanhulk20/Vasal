export const PLACEHOLDER_KEY = "YOUR_KEY";

export type Block = {
  // Set on the two rows of the Claude app tab.
  label?: string;
  text: string;
  accessibleName: string;
};

export type Snippet = {
  id: string;
  tab: string;
  line: string;
  blocks: Block[];
};

// The setup lines for each client, checked against each vendor's own docs on
// 27 Oct 2026. `mcp` is the server address and `key` is the issued key, or
// the placeholder before one exists.
export function snippetsFor(mcp: string, key: string): Snippet[] {
  const bearer = `Bearer ${key}`;
  return [
    {
      id: "claude-code",
      tab: "Claude Code",
      line: "Run this in a terminal. Add --scope user to use Vasal in every project.",
      blocks: [
        {
          text: `claude mcp add --transport http vasal ${mcp} --header "Authorization: ${bearer}"`,
          accessibleName: "Copy command",
        },
      ],
    },
    {
      id: "cursor",
      tab: "Cursor",
      line: "Add this to ~/.cursor/mcp.json, or to .cursor/mcp.json inside a project.",
      blocks: [
        {
          text: [
            "{",
            '  "mcpServers": {',
            '    "vasal": {',
            `      "url": "${mcp}",`,
            `      "headers": { "Authorization": "${bearer}" }`,
            "    }",
            "  }",
            "}",
          ].join("\n"),
          accessibleName: "Copy Cursor config",
        },
      ],
    },
    {
      id: "vs-code",
      tab: "VS Code",
      line: "Add this to .vscode/mcp.json in your project, for Copilot's agent mode.",
      blocks: [
        {
          text: [
            "{",
            '  "servers": {',
            '    "vasal": {',
            '      "type": "http",',
            `      "url": "${mcp}",`,
            `      "headers": { "Authorization": "${bearer}" }`,
            "    }",
            "  }",
            "}",
          ].join("\n"),
          accessibleName: "Copy VS Code config",
        },
      ],
    },
    {
      id: "windsurf",
      tab: "Windsurf",
      line: "Open Cascade's MCP config file and add this.",
      blocks: [
        {
          text: [
            "{",
            '  "mcpServers": {',
            '    "vasal": {',
            `      "serverUrl": "${mcp}",`,
            `      "headers": { "Authorization": "${bearer}" }`,
            "    }",
            "  }",
            "}",
          ].join("\n"),
          accessibleName: "Copy Windsurf config",
        },
      ],
    },
    {
      id: "codex",
      tab: "Codex",
      line: "Add this to ~/.codex/config.toml.",
      blocks: [
        {
          text: [
            "[mcp_servers.vasal]",
            `url = "${mcp}"`,
            `http_headers = { "Authorization" = "${bearer}" }`,
          ].join("\n"),
          accessibleName: "Copy Codex config",
        },
      ],
    },
    {
      id: "claude-app",
      tab: "Claude app",
      line: "In Claude, open Customize, then Connectors, then Add custom connector. Set sign-in to none and add one request header. Request headers are a beta that only some accounts have; if yours doesn't, use Other.",
      blocks: [
        { label: "Address", text: mcp, accessibleName: "Copy address" },
        { label: "authorization", text: bearer, accessibleName: "Copy authorization header" },
      ],
    },
    {
      id: "other",
      tab: "Other",
      line: "For any app that runs local MCP servers but can't send headers, the community bridge mcp-remote connects it. It needs Node 18 or later.",
      blocks: [
        {
          // The ${VASAL_AUTH} below is text for the client to expand, not ours.
          text: [
            "{",
            '  "mcpServers": {',
            '    "vasal": {',
            '      "command": "npx",',
            `      "args": ["mcp-remote", "${mcp}", "--header", "Authorization:\${VASAL_AUTH}", "--transport", "http-only"],`,
            `      "env": { "VASAL_AUTH": "${bearer}" }`,
            "    }",
            "  }",
            "}",
          ].join("\n"),
          accessibleName: "Copy mcp-remote config",
        },
      ],
    },
  ];
}
