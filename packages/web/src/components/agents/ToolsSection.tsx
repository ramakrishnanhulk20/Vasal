import Link from "next/link";
import { ToolStations } from "@/components/agents/ToolStations";
import { SECONDARY_LINK } from "@/lib/buttonStyle";
import { KICKER, SECTION_TITLE, SOFT_100 } from "@/lib/textStyles";

export function ToolsSection() {
  return (
    <section className="mt-[18vh]">
      <p className={KICKER}>WHAT YOUR AGENT CAN CALL</p>
      <h2 className={`mt-5 ${SECTION_TITLE}`} style={SOFT_100}>
        Four tools, in order.
      </h2>
      <p className="mt-[18px] max-w-[52ch] font-body text-[18px] text-rice-dim">
        Your agent finds the show, books a board for the one you confirm, reads it, and asks for a
        brief on any guest. Every call runs the same checks as the site.
      </p>
      <ToolStations />
      <div className="mt-14 flex">
        <Link href="/docs/api-and-mcp" className={SECONDARY_LINK}>
          <span className="link-draw">Read the API and MCP reference</span>
        </Link>
      </div>
    </section>
  );
}
