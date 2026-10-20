/**
 * Options for vi.waitFor on work a route or tool started in the background.
 * vi.waitFor gives up after one second by default, and under a full-suite run
 * a background database write can take three, so a correct test failed only
 * when the machine was busy. A wrong result still fails, just later.
 */
export const SETTLE = { timeout: 15_000, interval: 50 } as const;
