import Link from "next/link";
import { RunShell } from "@/components/run/RunShell";
import { SECONDARY_LINK } from "@/lib/buttonStyle";
import { KICKER, SECTION_TITLE, SOFT_100 } from "@/lib/textStyles";

// The page for a path that does not exist. The 404 for unmatched paths and the
// hidden lab page in production share it.
export function SiteNotFound() {
  return (
    <RunShell>
      <p className={KICKER}>NOT FOUND</p>
      <h1 className={`mt-5 ${SECTION_TITLE}`} style={SOFT_100}>
        There is no page here.
      </h1>
      <div className="mt-8 flex">
        <Link href="/" className={SECONDARY_LINK}>
          <span className="link-draw">Back to the home page</span>
        </Link>
      </div>
    </RunShell>
  );
}
