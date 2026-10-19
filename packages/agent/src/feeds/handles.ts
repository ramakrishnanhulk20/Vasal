import { randomUUID } from "node:crypto";
import { FeedError } from "./errors.js";

export type FeedSource = "visitor" | "directory";

/**
 * Opaque references to the feed URLs the server itself accepted for one run
 * (C1.5). The model and the client only ever see a handle, so they can pick
 * between URLs the server issued but can never name a URL of their own.
 * Create one instance per run.
 */
export class FeedHandles {
  // A Map, not a plain object, so strings like "__proto__" or "constructor"
  // can never resolve to something that was not issued.
  readonly #issued = new Map<string, { url: URL; source: FeedSource }>();

  /**
   * Records a URL the server has accepted and returns a fresh random handle
   * for it (crypto.randomUUID, 122 random bits). The URL is copied, so later
   * changes to the caller's URL object do not change what the handle means.
   */
  issue(url: URL, source: FeedSource): string {
    const handle = randomUUID();
    this.#issued.set(handle, { url: new URL(url.href), source });
    return handle;
  }

  /**
   * Returns a copy of the URL behind a handle this instance issued.
   * Throws FeedError FEED_UNKNOWN_HANDLE for anything else, including a
   * string that is itself a URL and handles issued by another instance.
   */
  resolve(handle: string): URL {
    const entry = this.#issued.get(handle);
    if (entry === undefined) throw new FeedError("FEED_UNKNOWN_HANDLE");
    return new URL(entry.url.href);
  }
}
