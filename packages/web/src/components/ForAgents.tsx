import { CopyCommand } from "@/components/CopyCommand";
import { SECONDARY_LINK } from "@/lib/buttonStyle";
import { KICKER, SECTION_TITLE, SOFT_100 } from "@/lib/textStyles";

const TOOLS = [
  { name: "find_show", job: "Find the show and its candidates." },
  { name: "book_guests", job: "Run the agent on the show you confirm." },
  { name: "get_board", job: "Read the ranked board." },
  { name: "write_brief", job: "Write one guest's brief and pitch." },
];

export function ForAgents() {
  return (
    <section id="agents" className="relative z-20 px-[6vw] py-[14vh]">
      <div className="grid grid-cols-1 gap-y-14 md:grid-cols-12 md:gap-y-0">
        <div className="md:col-span-5">
          <p className={KICKER}>FOR AGENTS</p>
          <h2 className={`mt-5 ${SECTION_TITLE}`} style={SOFT_100}>
            Your agent can book guests too.
          </h2>
          <p className="mt-5 max-w-[38ch] font-body text-[18px] leading-[1.6] text-rice-dim">
            Vasal is also a remote MCP server. Any agent that speaks MCP can find a show, book a
            board and write a brief with the same checks the site uses.
          </p>
          <ul className="mt-7 divide-y divide-rule">
            {TOOLS.map((tool) => (
              <li
                key={tool.name}
                className="grid grid-cols-[8.5rem_1fr] items-baseline gap-x-4 py-[14px]"
              >
                <span className="font-mono text-[14px] text-rice">{tool.name}</span>
                <span className="font-body text-[15px] text-rice-dim">{tool.job}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="md:col-span-6 md:col-start-7">
          <CopyCommand />
          <p className="mt-6 max-w-[52ch] font-body text-[15px] leading-[1.6] text-rice-dim">
            Keys come from the site after a human check. Each key has daily limits, and agents never
            spend the website&apos;s share.
          </p>
          <div className="mt-3 flex">
            <a href="/agents" className={SECONDARY_LINK}>
              <span className="link-draw">Get an agent key</span>
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
