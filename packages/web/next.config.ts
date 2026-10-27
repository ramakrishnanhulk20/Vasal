import type { NextConfig } from "next";
import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

const TURNSTILE = "https://challenges.cloudflare.com";
const apiOrigin = new URL(process.env.NEXT_PUBLIC_VASAL_API_URL || "https://api.vasal.site").origin;

// 'unsafe-inline' stays on scripts because the App Router writes its page data
// into inline scripts and the pages are static, so there is no per-request nonce
// to put on them. The policy's job is to stop a script or a request reaching any
// other host.
const contentSecurityPolicy = [
  "default-src 'self'",
  // No 'unsafe-eval': src/instrumentation-client.ts turns off zod's eval probe.
  `script-src 'self' 'unsafe-inline' ${TURNSTILE}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self' ${apiOrigin} ${TURNSTILE}`,
  `frame-src ${TURNSTILE}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const nextConfig: NextConfig = {
  // Stops "next dev" from writing an AGENTS.md into the app folder.
  agentRules: false,
  // A check build sets NEXT_DIST_DIR so it never writes into the folder the dev server is using.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  experimental: {
    // Two root layouts leave no single layout to build a 404 for unknown paths from.
    globalNotFound: true,
    // The persisted dev cache once kept serving CSS without newly added
    // classes after a restart; a slower dev start is the cheaper failure.
    turbopackFileSystemCacheForDev: false,
  },
  // Production only: the dev server's hot reload needs inline and eval scripts that this policy refuses.
  async headers() {
    if (process.env.NODE_ENV !== "production") return [];
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
  // Tailwind runs through its Turbopack loader because the app has no PostCSS config.
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default withMDX(nextConfig);
