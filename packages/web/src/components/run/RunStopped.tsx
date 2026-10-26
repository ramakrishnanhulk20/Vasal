import Link from "next/link";
import { SECONDARY_LINK } from "@/lib/buttonStyle";
import { failureReason } from "@/lib/failure";
import { KICKER, SECTION_TITLE, SOFT_100 } from "@/lib/textStyles";

// Shown when a run stopped, live or opened later from its link.
export function RunStopped({ code }: { code: string | null }) {
  return (
    <div className="mt-14 max-w-[40rem]">
      <p className={KICKER}>THE RUN STOPPED</p>
      <h2 className={`mt-5 ${SECTION_TITLE}`} style={SOFT_100}>
        {failureReason(code)}
      </h2>
      {code && <p className="mt-5 font-mono text-xs text-rice-dim">{code}</p>}
      <div className="mt-8 flex">
        <Link href="/#try" className={SECONDARY_LINK}>
          <span className="link-draw">Try another show</span>
        </Link>
      </div>
    </div>
  );
}
