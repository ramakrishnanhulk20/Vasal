import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Stops "next dev" from writing an AGENTS.md into the app folder.
  agentRules: false,
  // A check build sets NEXT_DIST_DIR so it never writes into the folder the dev server is using.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  experimental: {
    // The persisted dev cache once kept serving CSS without newly added
    // classes after a restart; a slower dev start is the cheaper failure.
    turbopackFileSystemCacheForDev: false,
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

export default nextConfig;
