// Not covered here: the agent tool that will accept handles (it does not exist
// yet), and whether an issued URL is safe to fetch (safe-fetch.test.ts).
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeedError } from "../src/feeds/errors.js";
import { FeedHandles } from "../src/feeds/handles.js";

function unknownHandleCode(handles: FeedHandles, handle: string): string | null {
  try {
    handles.resolve(handle);
    return null;
  } catch (err) {
    return err instanceof FeedError ? err.code : "not a FeedError";
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("C1.5 only server-issued handles resolve to a URL", () => {
  it("issues a random UUID that resolves to a copy of the URL", () => {
    const handles = new FeedHandles();
    const original = new URL("https://feeds.example.com/show.xml");
    const handle = handles.issue(original, "directory");
    expect(handle).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(handles.issue(original, "directory")).not.toBe(handle);

    original.hostname = "169.254.169.254";
    const resolved = handles.resolve(handle);
    expect(resolved.href).toBe("https://feeds.example.com/show.xml");
    resolved.hostname = "127.0.0.1";
    expect(handles.resolve(handle).href).toBe("https://feeds.example.com/show.xml");
  });

  it("refuses a raw URL string and an unknown UUID, with no connection attempted", () => {
    const connectSpy = vi.spyOn(net, "connect");
    const handles = new FeedHandles();
    handles.issue(new URL("https://feeds.example.com/show.xml"), "visitor");

    expect(unknownHandleCode(handles, "https://feeds.example.com/show.xml")).toBe("FEED_UNKNOWN_HANDLE");
    expect(unknownHandleCode(handles, "http://169.254.169.254/latest/meta-data/")).toBe("FEED_UNKNOWN_HANDLE");
    expect(unknownHandleCode(handles, "6f1c2a8e-3b4d-4e5f-9a0b-1c2d3e4f5a6b")).toBe("FEED_UNKNOWN_HANDLE");
    expect(unknownHandleCode(handles, "__proto__")).toBe("FEED_UNKNOWN_HANDLE");
    expect(unknownHandleCode(handles, "constructor")).toBe("FEED_UNKNOWN_HANDLE");
    expect(unknownHandleCode(handles, "")).toBe("FEED_UNKNOWN_HANDLE");
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it("does not resolve a handle issued by a different run's instance", () => {
    const runA = new FeedHandles();
    const runB = new FeedHandles();
    const handle = runA.issue(new URL("https://feeds.example.com/a.xml"), "visitor");
    expect(unknownHandleCode(runB, handle)).toBe("FEED_UNKNOWN_HANDLE");
  });
});
