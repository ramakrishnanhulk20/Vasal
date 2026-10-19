// Covers buildDataset with synthetic stub dependencies: the order of the
// pre-registered rules, every drop counter, the fit batch cap, and that
// YouTube is read only through the pinned channel. It does not cover the
// real YouTube, Qloo or model adapters (not wired yet), how well the model
// extracts names, or the statistics themselves (backtest-stats.test.ts).
// Every id, name and score here is invented; no Qloo data is used.
import { describe, expect, it } from "vitest";
import { analyse } from "../src/backtest/analyse.js";
import { buildDataset, type FitScore, type PipelineDeps } from "../src/backtest/pipeline.js";
import { mulberry32 } from "../src/backtest/random.js";
import type { Dataset, DatasetRow, ShowConfig, ShowOutcome } from "../src/backtest/types.js";

const NOW = new Date("2026-10-19T00:00:00.000Z");
const IN_WINDOW = "2025-06-01T12:00:00Z";
const FULL_LENGTH = 3_600;

type Guest = { kind: "one"; name: string } | { kind: "none" } | { kind: "several" };
type Person = { id: string; name: string; popularity: number };
type Video = { videoId: string; title: string; publishedAt: string; durationSec: number | null; views: number; hidden: boolean };

type World = {
  channels: Map<string, Video[]>;
  podcasts: Map<string, Array<{ id: string; name: string }>>;
  guests: Map<string, Guest>;
  people: Map<string, Person | null>;
  fit: Map<string, FitScore>;
};

const emptyWorld = (): World => ({
  channels: new Map(),
  podcasts: new Map(),
  guests: new Map(),
  people: new Map(),
  fit: new Map(),
});

const channelIdFor = (key: string) => `UC${key.padEnd(22, "x")}`;
const videoIdFor = (key: string, index: number) => `${key}${String(index).padStart(11 - key.length, "0")}`;

function pinned(name: string, key: string | null, titleMustContain?: string): ShowConfig {
  return {
    name,
    youtubeChannelId: key === null ? null : channelIdFor(key),
    youtubeHandle: key === null ? null : `@synthetic${key}`,
    ...(titleMustContain === undefined ? {} : { titleMustContain }),
    evidenceUrl: "https://example.com/synthetic",
    checkedOn: "2026-10-19",
  };
}

// The popularity search returns is deliberately one value for everyone, so
// a test can tell it apart from the fame that fitScores returns.
const SEARCH_POPULARITY = 0.99;

function addVideo(world: World, key: string, video: Partial<Video> & { title: string }, guest?: Guest): Video {
  const list = world.channels.get(channelIdFor(key)) ?? [];
  world.channels.set(channelIdFor(key), list);
  const full: Video = {
    videoId: videoIdFor(key, list.length),
    publishedAt: IN_WINDOW,
    durationSec: FULL_LENGTH,
    views: 10_000 + list.length * 37,
    hidden: false,
    ...video,
  };
  list.push(full);
  if (guest !== undefined) world.guests.set(full.title, guest);
  return full;
}

// One full-length episode with one named guest who resolves in "Qloo" and
// has a fit score and a fame, unless told otherwise.
function addGuestEpisode(
  world: World,
  key: string,
  guestName: string,
  opts: { scored?: boolean; fame?: number | null; title?: string } = {},
) {
  const title = opts.title ?? `${guestName} | Synthetic Show ${key}`;
  addVideo(world, key, { title }, { kind: "one", name: guestName });
  const id = `synthetic-person-${guestName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  if (!world.people.has(guestName)) world.people.set(guestName, { id, name: guestName, popularity: SEARCH_POPULARITY });
  const popularity = opts.fame === undefined ? 0.2 + (id.length % 7) / 10 : opts.fame;
  if (opts.scored !== false && !world.fit.has(id)) world.fit.set(id, { affinity: (id.length % 11) / 10, popularity });
}

function stubDeps(world: World, now: Date = NOW) {
  const calls = {
    youtubeProps: new Set<string>(),
    channelUploads: [] as string[],
    listUploadsOpts: [] as unknown[],
    videoStatsSizes: [] as number[],
    findPodcasts: [] as string[],
    extracted: [] as string[],
    resolved: [] as string[],
    fitBatches: [] as string[][],
  };
  const owner = new Map<string, { video: Video; channelId: string }>();
  for (const [channelId, videos] of world.channels) for (const video of videos) owner.set(video.videoId, { video, channelId });

  const methods: PipelineDeps["youtube"] = {
    async channelUploads(id) {
      calls.channelUploads.push(id);
      if (!world.channels.has(id)) throw new Error("unknown synthetic channel");
      return { channelTitle: `Synthetic ${id}`, uploadsPlaylistId: `UU${id.slice(2)}` };
    },
    async listUploads(playlistId, opts) {
      calls.listUploadsOpts.push(opts);
      const videos = world.channels.get(`UC${playlistId.slice(2)}`) ?? [];
      return videos.map((video) => ({ videoId: video.videoId, title: video.title, publishedAt: video.publishedAt }));
    },
    async videoStats(ids) {
      calls.videoStatsSizes.push(ids.length);
      return ids.flatMap((id) => {
        const found = owner.get(id);
        if (found === undefined || found.video.hidden) return [];
        const { video, channelId } = found;
        return [
          {
            videoId: video.videoId,
            channelId,
            title: video.title,
            publishedAt: video.publishedAt,
            viewCount: video.views,
            durationSec: video.durationSec,
          },
        ];
      });
    },
  };
  // Records every property the pipeline touches, so the test can show it
  // never reaches for anything but the three pinned-channel reads.
  const youtube = new Proxy(methods, {
    get(target, property, receiver) {
      calls.youtubeProps.add(String(property));
      return Reflect.get(target, property, receiver);
    },
  });

  const deps: PipelineDeps = {
    youtube,
    async findPodcasts(showName) {
      calls.findPodcasts.push(showName);
      return world.podcasts.get(showName) ?? [];
    },
    async extractGuest(title) {
      calls.extracted.push(title);
      return world.guests.get(title) ?? { kind: "none" };
    },
    async resolvePerson(name) {
      calls.resolved.push(name);
      return world.people.get(name) ?? null;
    },
    async fitScores(_podcastId, personIds) {
      calls.fitBatches.push([...personIds]);
      const scores = new Map<string, FitScore>();
      for (const id of personIds) {
        const score = world.fit.get(id);
        if (score !== undefined) scores.set(id, score);
      }
      return scores;
    },
    now: () => now,
  };
  return { deps, calls };
}

// One run that trips every drop reason at least once.
function busyWorld() {
  const world = emptyWorld();
  world.podcasts.set("Lost Show", [
    { id: "synthetic-podcast-lost-1", name: "Lost Showcase" },
    { id: "synthetic-podcast-lost-2", name: "The Lost Show" },
  ]);
  world.podcasts.set("Twin Show", [
    { id: "synthetic-podcast-twin-1", name: "Twin Show" },
    { id: "synthetic-podcast-twin-2", name: "TWIN  SHOW" },
    { id: "synthetic-podcast-twin-3", name: "Twin Show Extra" },
  ]);
  world.podcasts.set("Main Show", [
    { id: "synthetic-podcast-main", name: "Main Show with Its Host" },
    { id: "synthetic-podcast-main", name: "Main Show" },
    { id: "synthetic-podcast-other", name: "Mainstream Show" },
  ]);
  world.podcasts.set("Small Show", [{ id: "synthetic-podcast-small", name: "Small Show" }]);
  addVideo(world, "lost", { title: "Never read" });
  addVideo(world, "twin", { title: "Never read" });

  for (let i = 0; i < 60; i += 1) addGuestEpisode(world, "main", `Avery Main${i}`);
  addGuestEpisode(world, "main", "Avery Main0", { title: "Avery Main0 returns | Synthetic Show main" });
  addVideo(world, "main", { title: "Private episode | Synthetic Show main", hidden: true }, { kind: "one", name: "Private" });
  addVideo(world, "main", { title: "Truth or Dab with Rory Other" }, { kind: "one", name: "Rory Other" });
  addVideo(world, "main", { title: "Early Guest | Synthetic Show main", publishedAt: "2024-09-30T23:59:00Z" }, { kind: "one", name: "Early Guest" });
  addVideo(world, "main", { title: "Short Guest | Synthetic Show main", durationSec: 1_199 }, { kind: "one", name: "Short Guest" });
  addVideo(world, "main", { title: "Unknown Length | Synthetic Show main", durationSec: null }, { kind: "one", name: "Unknown Length" });
  addVideo(world, "main", { title: "Best of the year | Synthetic Show main" }, { kind: "none" });
  addVideo(world, "main", { title: "Ann Lee and Bo Park | Synthetic Show main" }, { kind: "several" });
  addVideo(world, "main", { title: "A mystery guest | Synthetic Show main" }, { kind: "one", name: "Invented Person" });
  addVideo(world, "main", { title: "Nobody Known | Synthetic Show main" }, { kind: "one", name: "Nobody Known" });
  world.people.set("Nobody Known", null);
  addVideo(world, "main", { title: "Close Match | Synthetic Show main" }, { kind: "one", name: "Close Match" });
  world.people.set("Close Match", { id: "synthetic-person-close-matchington", name: "Close Matchington", popularity: 0.4 });
  addGuestEpisode(world, "main", "Unscored Person", { scored: false });
  addGuestEpisode(world, "main", "Fameless Person", { fame: null });

  for (let i = 0; i < 29; i += 1) addGuestEpisode(world, "small", `Blake Small${i}`);
  addGuestEpisode(world, "small", "Unscored Small1", { scored: false });
  addGuestEpisode(world, "small", "Unscored Small2", { scored: false });

  const shows = [
    pinned("No Channel Show", null),
    pinned("Lost Show", "lost"),
    pinned("Twin Show", "twin"),
    pinned("Main Show", "main", "Synthetic Show main"),
    pinned("Small Show", "small"),
  ];
  return { world, shows };
}

describe("buildDataset", () => {
  it("counts every drop reason at least once in one run, in the pre-registered order", async () => {
    const { world, shows } = busyWorld();
    const { deps } = stubDeps(world);
    const dataset = await buildDataset(shows, deps);

    expect(dataset.drops).toEqual({
      showNoChannel: 1,
      showNoPodcastMatch: 1,
      showAmbiguousPodcast: 1,
      notThisShow: 1,
      hiddenViews: 1,
      notInWindow: 1,
      tooShort: 2,
      noSingleGuest: 2,
      nameNotInTitle: 1,
      guestNotResolved: 2,
      noFitScore: 3,
      noFame: 1,
      showTooFewEpisodes: 1,
    });
    for (const count of Object.values(dataset.drops)) expect(count).toBeGreaterThanOrEqual(1);
    expect(dataset.shows.map((show) => [show.name, show.status])).toEqual([
      ["No Channel Show", "noChannel"],
      ["Lost Show", "noPodcastMatch"],
      ["Twin Show", "ambiguousPodcast"],
      ["Main Show", "kept"],
      ["Small Show", "tooFewEpisodes"],
    ]);
    expect(dataset.shows[3]).toMatchObject({ podcastId: "synthetic-podcast-main", uploadsRead: 73, eligibleEpisodes: 65, resolvedGuests: 63, rows: 61, cutShort: false });
    expect(dataset.rows).toHaveLength(61);
    expect(new Set(dataset.rows.map((row) => row.showName))).toEqual(new Set(["Main Show"]));
    expect(dataset.builtAt).toBe(NOW.toISOString());
  });

  it("C9.1 drops a guest whose extracted name is not in the title, and never looks it up", async () => {
    const { world, shows } = busyWorld();
    const { deps, calls } = stubDeps(world);
    const dataset = await buildDataset(shows, deps);

    expect(dataset.drops.nameNotInTitle).toBe(1);
    expect(calls.resolved).not.toContain("Invented Person");
    expect(dataset.rows.some((row) => row.guestName === "Invented Person")).toBe(false);
    for (const row of dataset.rows) expect(row.title.toLowerCase()).toContain(row.guestName.toLowerCase());
  });

  it("keeps a guest only when Qloo's top person has the same normalised name", async () => {
    const { world, shows } = busyWorld();
    const { deps } = stubDeps(world);
    const dataset = await buildDataset(shows, deps);
    expect(dataset.rows.some((row) => row.guestName === "Close Match")).toBe(false);
    expect(dataset.rows.some((row) => row.personId === "synthetic-person-close-matchington")).toBe(false);
  });

  it("drops a show with several matching podcasts instead of picking one, before any YouTube call", async () => {
    const { world, shows } = busyWorld();
    const { deps, calls } = stubDeps(world);
    await buildDataset(shows, deps);
    expect(calls.findPodcasts).toEqual(["Lost Show", "Twin Show", "Main Show", "Small Show"]);
    expect(calls.channelUploads).toEqual([channelIdFor("main"), channelIdFor("small")]);
  });

  it("never calls fitScores with more than 25 ids, and asks for each person once per show", async () => {
    const { world, shows } = busyWorld();
    const { deps, calls } = stubDeps(world);
    await buildDataset(shows, deps);
    expect(calls.fitBatches.map((batch) => batch.length)).toEqual([25, 25, 12, 25, 6]);
    for (const batch of calls.fitBatches) expect(new Set(batch).size).toBe(batch.length);
    expect(calls.resolved.filter((name) => name === "Avery Main0")).toHaveLength(1);
  });

  it("drops a show with 29 rows", async () => {
    const { world, shows } = busyWorld();
    const { deps } = stubDeps(world);
    const dataset = await buildDataset(shows, deps);
    expect(dataset.shows[4]).toMatchObject({ name: "Small Show", status: "tooFewEpisodes", eligibleEpisodes: 31, resolvedGuests: 31, rows: 29 });
    expect(dataset.rows.some((row) => row.showName === "Small Show")).toBe(false);
  });

  it("drops a show with 29 eligible episodes without looking up any guest", async () => {
    const world = emptyWorld();
    world.podcasts.set("Thin Show", [{ id: "synthetic-podcast-thin", name: "Thin Show" }]);
    for (let i = 0; i < 29; i += 1) addGuestEpisode(world, "thin", `Casey Thin${i}`);
    addVideo(world, "thin", { title: "Trailer | Synthetic Show thin", durationSec: 90 });
    const { deps, calls } = stubDeps(world);
    const dataset = await buildDataset([pinned("Thin Show", "thin")], deps);
    expect(dataset.drops.showTooFewEpisodes).toBe(1);
    expect(dataset.shows[0]).toMatchObject({ eligibleEpisodes: 29, rows: 0 });
    expect(calls.resolved).toEqual([]);
    expect(calls.fitBatches).toEqual([]);
  });

  it("reads YouTube only through the pinned channel's uploads, with no search method anywhere", async () => {
    const { world, shows } = busyWorld();
    const { deps, calls } = stubDeps(world);
    expect(Object.keys(deps.youtube).sort()).toEqual(["channelUploads", "listUploads", "videoStats"]);
    expect("search" in deps.youtube).toBe(false);
    await buildDataset(shows, deps);
    for (const property of calls.youtubeProps) expect(["channelUploads", "listUploads", "videoStats"]).toContain(property);
    expect(calls.listUploadsOpts).toEqual([{ maxItems: 2_000 }, { maxItems: 2_000 }]);
  });

  it("keeps at most 2000 uploads per channel even if more come back", async () => {
    const world = emptyWorld();
    world.podcasts.set("Busy Show", [{ id: "synthetic-podcast-busy", name: "Busy Show" }]);
    for (let i = 0; i < 2_005; i += 1) addVideo(world, "busy", { title: `Clip ${i}`, durationSec: 60 });
    const { deps, calls } = stubDeps(world);
    const dataset = await buildDataset([pinned("Busy Show", "busy")], deps);
    expect(calls.videoStatsSizes).toEqual([2_000]);
    expect(dataset.shows[0]?.uploadsRead).toBe(2_000);
    expect(dataset.drops.tooShort).toBe(2_000);
    expect(dataset.shows[0]?.cutShort).toBe(true);
  });

  it("stores whole days from publication to now as ageDays", async () => {
    const world = emptyWorld();
    world.podcasts.set("Age Show", [{ id: "synthetic-podcast-age", name: "Age Show" }]);
    addVideo(world, "age", { title: "Dana Age | Synthetic Show age", publishedAt: "2026-07-31T12:00:00Z" }, { kind: "one", name: "Dana Age" });
    world.people.set("Dana Age", { id: "synthetic-person-dana-age", name: "Dana Age", popularity: SEARCH_POPULARITY });
    world.fit.set("synthetic-person-dana-age", { affinity: 0.7, popularity: 0.5 });
    for (let i = 0; i < 30; i += 1) addGuestEpisode(world, "age", `Ellis Age${i}`);
    const { deps } = stubDeps(world);
    const dataset = await buildDataset([pinned("Age Show", "age")], deps);
    const row = dataset.rows.find((candidate) => candidate.guestName === "Dana Age");
    expect(row).toMatchObject({ ageDays: 79, fit: 0.7, fame: 0.5, personId: "synthetic-person-dana-age" });
  });

  it("on a shared channel keeps only titles that contain the show's name, and counts the rest as notThisShow", async () => {
    const world = emptyWorld();
    world.podcasts.set("Hot Ones", [{ id: "synthetic-podcast-hot", name: "Hot Ones" }]);
    for (let i = 0; i < 30; i += 1) addGuestEpisode(world, "fwf", `Kit Wings${i}`, { title: `Kit Wings${i} Eats Spicy Wings | Hot Ones` });
    addGuestEpisode(world, "fwf", "Lee Caps", { title: "Lee Caps | HOT  ONES" });
    addVideo(world, "fwf", { title: "Truth or Dab with Rory Other" }, { kind: "one", name: "Rory Other" });
    addVideo(world, "fwf", { title: "The Burger Show with Sam Patty", hidden: true });
    addVideo(world, "fwf", { title: "Lost Episode | Hot Ones", hidden: true });

    const { deps, calls } = stubDeps(world);
    const dataset = await buildDataset([pinned("Hot Ones", "fwf", "Hot Ones")], deps);
    expect(dataset.drops.notThisShow).toBe(2);
    expect(dataset.drops.hiddenViews).toBe(1);
    expect(dataset.shows[0]).toMatchObject({ status: "kept", uploadsRead: 34, rows: 31 });
    expect(calls.extracted).not.toContain("Truth or Dab with Rory Other");
    expect(dataset.rows.some((row) => row.guestName === "Lee Caps")).toBe(true);

    const unfiltered = await buildDataset([pinned("Hot Ones", "fwf")], stubDeps(world).deps);
    expect(unfiltered.drops.notThisShow).toBe(0);
    expect(unfiltered.drops.hiddenViews).toBe(2);
    expect(unfiltered.rows).toHaveLength(31);
  });

  it("takes fame from the fitScores response, never from search, and drops a missing fame as noFame", async () => {
    const world = emptyWorld();
    world.podcasts.set("Fame Show", [{ id: "synthetic-podcast-fame", name: "Fame Show" }]);
    for (let i = 0; i < 30; i += 1) addGuestEpisode(world, "fame", `Gale Fame${i}`);
    addGuestEpisode(world, "fame", "Nova Fameless", { fame: null });
    addGuestEpisode(world, "fame", "Odd Fame", { fame: Number.NaN });

    const { deps } = stubDeps(world);
    const dataset = await buildDataset([pinned("Fame Show", "fame")], deps);
    expect(dataset.drops.noFame).toBe(2);
    expect(dataset.drops.noFitScore).toBe(0);
    expect(dataset.rows).toHaveLength(30);
    for (const row of dataset.rows) {
      expect(row.fame).not.toBe(SEARCH_POPULARITY);
      expect(row.fame).toBe(world.fit.get(row.personId)?.popularity);
      expect(row.fit).toBe(world.fit.get(row.personId)?.affinity);
    }
  });

  it("marks a show cutShort when the 2000-upload cap ends inside the window, and keeps it", async () => {
    const world = emptyWorld();
    world.podcasts.set("Capped Show", [{ id: "synthetic-podcast-cap", name: "Capped Show" }]);
    for (let i = 0; i < 30; i += 1) addGuestEpisode(world, "cap", `Max Cap${i}`);
    for (let i = 0; i < 1_970; i += 1) addVideo(world, "cap", { title: `Clip ${i}`, durationSec: 60, publishedAt: "2024-10-01T00:00:00Z" });
    const dataset = await buildDataset([pinned("Capped Show", "cap")], stubDeps(world).deps);
    expect(dataset.shows[0]).toMatchObject({ status: "kept", uploadsRead: 2_000, cutShort: true, rows: 30 });
  });

  it("does not mark cutShort when the capped list reaches before the window, or the cap was not hit", async () => {
    const reaching = emptyWorld();
    reaching.podcasts.set("Deep Show", [{ id: "synthetic-podcast-deep", name: "Deep Show" }]);
    for (let i = 0; i < 1_999; i += 1) addVideo(reaching, "deep", { title: `Clip ${i}`, durationSec: 60 });
    addVideo(reaching, "deep", { title: "Old clip", durationSec: 60, publishedAt: "2024-09-30T23:59:59Z" });
    const deep = await buildDataset([pinned("Deep Show", "deep")], stubDeps(reaching).deps);
    expect(deep.shows[0]).toMatchObject({ uploadsRead: 2_000, cutShort: false });

    const short = emptyWorld();
    short.podcasts.set("Short List Show", [{ id: "synthetic-podcast-short", name: "Short List Show" }]);
    for (let i = 0; i < 1_999; i += 1) addVideo(short, "shortl", { title: `Clip ${i}`, durationSec: 60 });
    const shortList = await buildDataset([pinned("Short List Show", "shortl")], stubDeps(short).deps);
    expect(shortList.shows[0]).toMatchObject({ uploadsRead: 1_999, cutShort: false });
  });

  it("refuses to build before the episode window has closed", async () => {
    const { world, shows } = busyWorld();
    const { deps, calls } = stubDeps(world, new Date("2026-07-15T00:00:00Z"));
    await expect(buildDataset(shows, deps)).rejects.toThrow(RangeError);
    expect(calls.findPodcasts).toEqual([]);
  });

  it("stops when YouTube returns a video from another channel", async () => {
    const world = emptyWorld();
    world.podcasts.set("Mixed Show", [{ id: "synthetic-podcast-mixed", name: "Mixed Show" }]);
    addGuestEpisode(world, "mixed", "Frankie Mixed");
    const { deps } = stubDeps(world);
    const real = deps.youtube;
    deps.youtube = {
      channelUploads: (id) => real.channelUploads(id),
      listUploads: (id, opts) => real.listUploads(id, opts),
      async videoStats(ids) {
        return (await real.videoStats(ids)).map((stats) => ({ ...stats, channelId: channelIdFor("other") }));
      },
    };
    await expect(buildDataset([pinned("Mixed Show", "mixed")], deps)).rejects.toThrow("another channel");
  });
});

const DAY_MS = 86_400_000;
const NO_DROPS = {
  notThisShow: 0,
  notInWindow: 0,
  tooShort: 0,
  hiddenViews: 0,
  noSingleGuest: 0,
  nameNotInTitle: 0,
  guestNotResolved: 0,
  noFitScore: 0,
  noFame: 0,
  showNoChannel: 0,
  showNoPodcastMatch: 0,
  showAmbiguousPodcast: 0,
  showTooFewEpisodes: 0,
};

// `link` sets how strongly fit drives views: positive, zero or negative.
function syntheticDataset(showCount: number, link: number, seed = 3): Dataset {
  const random = mulberry32(seed);
  const shows: ShowOutcome[] = [];
  const rows: DatasetRow[] = [];
  for (let s = 0; s < showCount; s += 1) {
    const name = `Synthetic Show ${s}`;
    const n = 40;
    for (let i = 0; i < n; i += 1) {
      const fit = random();
      const fame = random();
      const ageDays = 80 + Math.floor(random() * 600);
      const views = Math.round(Math.exp(10 + link * fit + 0.5 * Math.log(ageDays) + 0.6 * (random() - 0.5)));
      rows.push({
        showName: name,
        videoId: videoIdFor(`s${s}`, i),
        title: `Guest S${s}x${i} | ${name}`,
        publishedAt: new Date(NOW.getTime() - ageDays * DAY_MS).toISOString(),
        ageDays,
        views,
        guestName: `Guest S${s}x${i}`,
        personId: `synthetic-person-${s}-${i}`,
        fit,
        fame,
      });
    }
    shows.push({
      name,
      youtubeChannelId: channelIdFor(`s${s}`),
      podcastId: `synthetic-podcast-${s}`,
      status: "kept",
      uploadsRead: n,
      eligibleEpisodes: n,
      resolvedGuests: n,
      rows: n,
      cutShort: false,
    });
  }
  return { builtAt: NOW.toISOString(), shows, rows, drops: { ...NO_DROPS } };
}

describe("analyse", () => {
  it("gives a decision with 6 shows, supported when fit drives views", () => {
    const result = analyse(syntheticDataset(6, 3));
    expect(result.status).toBe("analysed");
    expect(result.sample).toEqual({ shows: 6, episodes: 240 });
    expect(result.shows.map((show) => show.n)).toEqual([40, 40, 40, 40, 40, 40]);
    for (const show of result.shows) expect(show.rhoFitViews).toBeGreaterThan(0);
    expect(result.h1.decision).toBe("supported");
    expect(result.h1.pooledRho).toBeGreaterThan(0);
    expect(result.h1.interval?.low).toBeGreaterThan(0);
    expect(result.h1.interval?.iterations).toBe(10_000);
    expect(result.h2.decision).toBe("supported");
    expect(result.descriptive.medianAdjustedViewRatioTopToBottomFitQuintile).toBeGreaterThan(1);
    expect(result.bootstrap).toEqual({ iterations: 10_000, seed: 20261019 });
    expect(result.method.length).toBeGreaterThan(0);
  });

  it("says not supported when the link runs the other way", () => {
    const result = analyse(syntheticDataset(6, -3));
    expect(result.h1.pooledRho).toBeLessThan(0);
    expect(result.h1.decision).toBe("not supported");
    expect(result.h2.decision).toBe("not supported");
  });

  it("reports insufficient data with 5 shows and claims no correlation", () => {
    const result = analyse(syntheticDataset(5, 3));
    expect(result.status).toBe("insufficient data");
    expect(result.h1).toEqual({ pooledRho: null, interval: null, decision: "insufficient data" });
    expect(result.h2).toEqual({ pooledRho: null, interval: null, decision: "insufficient data" });
    expect(result.shows.every((show) => show.rhoFitViews === null && show.partialRhoFitViewsGivenFame === null)).toBe(true);
    expect(result.descriptive.medianAdjustedViewRatioTopToBottomFitQuintile).toBeNull();
    expect(result.sample).toEqual({ shows: 5, episodes: 200 });
  });

  it("carries cutShort into the per-show output, with or without enough shows", () => {
    for (const showCount of [6, 5]) {
      const dataset = syntheticDataset(showCount, 1);
      dataset.shows[2]!.cutShort = true;
      const result = analyse(dataset);
      expect(result.shows.map((show) => show.cutShort)).toEqual(dataset.shows.map((_, i) => i === 2));
    }
  });

  it("C9.3 gives byte-identical JSON twice, and again from a stored copy", () => {
    const dataset = syntheticDataset(6, 0.5);
    const first = JSON.stringify(analyse(dataset));
    const second = JSON.stringify(analyse(dataset));
    const stored = JSON.stringify(analyse(JSON.parse(JSON.stringify(dataset)) as Dataset));
    expect(second).toBe(first);
    expect(stored).toBe(first);
  });

  it("carries the pipeline's drop counts and show outcomes through to the result", async () => {
    const { world, shows } = busyWorld();
    const { deps } = stubDeps(world);
    const dataset = await buildDataset(shows, deps);
    const result = analyse(dataset);
    expect(result.status).toBe("insufficient data");
    expect(result.drops).toEqual(dataset.drops);
    expect(result.showOutcomes).toEqual(dataset.shows);
    expect(result.sample).toEqual({ shows: 1, episodes: 61 });
  });

  it("refuses a stored dataset that breaks the inclusion rule", () => {
    const dataset = syntheticDataset(6, 1);
    const shortShow = { ...dataset, rows: dataset.rows.slice(11), shows: dataset.shows.map((show, i) => (i === 0 ? { ...show, rows: 29 } : show)) };
    expect(() => analyse(shortShow)).toThrow(RangeError);
    const stray = { ...dataset, rows: [...dataset.rows, { ...dataset.rows[0]!, showName: "Not Kept" }] };
    expect(() => analyse(stray)).toThrow(RangeError);
    const miscounted = { ...dataset, shows: dataset.shows.map((show, i) => (i === 0 ? { ...show, rows: 41 } : show)) };
    expect(() => analyse(miscounted)).toThrow(RangeError);
  });
});
