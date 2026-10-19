import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createYouTubeClient } from "../src/youtube/client.js";
import { YouTubeError } from "../src/youtube/errors.js";

const REPO_ROOT_ENV_FILE = fileURLToPath(new URL("../../../.env", import.meta.url));
const USAGE = "Usage: npm run youtube:demo -- <channelId>";
// A demo run needs 5 units (1 channel, 2 pages, 2 stats batches). The cap
// keeps a mistake from spending more than a sliver of the daily quota.
const UNIT_CAP = 30;
const MAX_UPLOADS = 100;
const NEWEST_SHOWN = 5;

const viewsFormat = new Intl.NumberFormat("en-US");

// Titles are written by channel owners. Control and direction characters are
// dropped so a title cannot move the cursor or reorder what the terminal shows.
const printable = (text: string) => text.replace(/[\p{Cc}\p{Bidi_Control}]/gu, "");

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "length unknown";
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

async function main(): Promise<void> {
  if (existsSync(REPO_ROOT_ENV_FILE)) process.loadEnvFile(REPO_ROOT_ENV_FILE);
  const apiKey = process.env.YOUTUBE_API_KEY?.trim() ?? "";
  if (apiKey === "") {
    console.error("YOUTUBE_API_KEY is not set. Add it to .env (see .env.example).");
    process.exitCode = 1;
    return;
  }

  const channelId = process.argv[2]?.trim() ?? "";
  if (channelId === "") {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  let unitsUsed = 0;
  const reserveUnits = async (units: number) => {
    if (unitsUsed + units > UNIT_CAP) return false;
    unitsUsed += units;
    return true;
  };
  const youtube = createYouTubeClient({ apiKey, reserveUnits });

  try {
    const channel = await youtube.channelUploads(channelId);
    const uploads = await youtube.listUploads(channel.uploadsPlaylistId, { maxItems: MAX_UPLOADS });
    const stats = await youtube.videoStats(uploads.map((upload) => upload.videoId));
    const newest = [...stats]
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
      .slice(0, NEWEST_SHOWN);

    console.log(`Channel: ${printable(channel.channelTitle)}`);
    console.log(`Uploads read: ${uploads.length}`);
    console.log(`Newest ${newest.length} with public view counts:`);
    for (const video of newest) {
      const views = `${viewsFormat.format(video.viewCount)} views`;
      console.log(`  ${video.publishedAt.slice(0, 10)}  ${views}  ${formatDuration(video.durationSec)}  ${printable(video.title)}`);
    }
  } finally {
    console.log(`YouTube units used: ${unitsUsed} of ${UNIT_CAP}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof YouTubeError ? `Stopped with ${err.code}: ${err.message}` : "Stopped with an unexpected error.");
  process.exitCode = 1;
});
