import type { Metadata } from "next";
import { KeyDesk } from "@/components/agents/KeyDesk";
import { ToolsSection } from "@/components/agents/ToolsSection";
import { RunShell } from "@/components/run/RunShell";
import { loadKeyDesk } from "@/lib/agentKeys";

export const metadata: Metadata = {
  title: "Agent keys | Vasal",
  description:
    "Give your AI agent a Vasal key. Over MCP it can find a show, build a guest board from Qloo's taste data and write briefs, with the same checks as the site.",
};

export default async function AgentsPage() {
  const desk = await loadKeyDesk();

  return (
    <RunShell>
      <KeyDesk desk={desk} />
      <ToolsSection />
    </RunShell>
  );
}
