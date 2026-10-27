import Link from "next/link";
import { RunShell } from "@/components/run/RunShell";
import { SECONDARY_LINK } from "@/lib/buttonStyle";
import { KICKER, SECTION_TITLE, SOFT_100 } from "@/lib/textStyles";

export default function RunNotFound() {
  return (
    <RunShell>
      <p className={KICKER}>NOT FOUND</p>
      <h1 className={`mt-5 ${SECTION_TITLE}`} style={SOFT_100}>
        There is no board here.
      </h1>
      <div className="mt-8 flex">
        <Link href="/#showcase" className={SECONDARY_LINK}>
          <span className="link-draw">Back to the boards</span>
        </Link>
      </div>
    </RunShell>
  );
}
