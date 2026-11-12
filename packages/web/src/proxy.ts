import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isArchive } from "@/lib/archive";

const KEPT_PATHS = new Set(["/", "/proof"]);

// In archive mode only the record and the proof page exist. Everything else
// that reaches the app, including paths that never existed, goes back to "/".
export function proxy(request: NextRequest) {
  if (!isArchive() || KEPT_PATHS.has(request.nextUrl.pathname)) return NextResponse.next();
  const home = request.nextUrl.clone();
  home.pathname = "/";
  home.search = "";
  return NextResponse.redirect(home, 307);
}

// Next's own files and the favicon are left alone, so the page can still load its scripts and fonts.
export const config = {
  matcher: ["/((?!_next/|icon\\.svg$).*)"],
};
