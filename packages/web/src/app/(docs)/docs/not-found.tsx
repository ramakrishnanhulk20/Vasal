import Link from "next/link";
import { DocsBody, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";

export default function DocsNotFound() {
  return (
    <DocsPage>
      <DocsTitle>There is no page here.</DocsTitle>
      <DocsBody>
        <p>
          <Link href="/docs">Back to the docs</Link>
        </p>
      </DocsBody>
    </DocsPage>
  );
}
