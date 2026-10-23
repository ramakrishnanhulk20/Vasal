// Checks the race harness itself on the hosted throwaway database. The
// control proves the 50 connections really overlap: a cap written as an
// unlocked read and then a write over-grants here, so the exact counts in
// races.test.ts mean the real code is atomic, not that nothing raced. The
// guard proves freshSchema refuses a database holding tables Vasal does not
// own, before it changes anything.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/store/db.js";
import { setBucket, usage } from "../../src/store/meter.js";
import { CONTENDERS, freshSchema, HOSTED_URL, openContenders, race } from "./harness.js";

const RACE_TIMEOUT_MS = 120_000;

let admin: Db;
let contenders: Db[] = [];

describe.skipIf(HOSTED_URL === undefined)("hosted race harness", () => {
  beforeAll(async () => {
    const [first] = await openContenders(1);
    if (first === undefined) throw new Error("openContenders gave no connection");
    admin = first;
    contenders = await openContenders(CONTENDERS);
  }, RACE_TIMEOUT_MS);

  afterAll(async () => {
    await admin?.query("DROP TABLE IF EXISTS public.not_vasal");
    await Promise.allSettled([admin, ...contenders].map((db) => db?.close()));
  }, RACE_TIMEOUT_MS);

  it(
    "an unlocked read-then-write cap over-grants under the same race",
    async () => {
      await freshSchema(admin);
      await setBucket(admin, { key: "control:day", cap: 10, windowEnd: new Date(Date.now() + 86_400_000) });
      const results = await race(contenders, async (db) => {
        const { rows } = await db.query<{ used: number; cap: number }>("SELECT used, cap FROM usage_buckets WHERE key = $1", ["control:day"]);
        const bucket = rows[0];
        if (bucket === undefined || bucket.used >= bucket.cap) return false;
        await db.query("UPDATE usage_buckets SET used = used + 1 WHERE key = $1", ["control:day"]);
        return true;
      });
      const granted = results.filter((result) => result.ok && result.value === true).length;
      expect(granted).toBeGreaterThan(10);
      expect((await usage(admin, "control:day"))?.used).toBe(granted);
    },
    RACE_TIMEOUT_MS,
  );

  it(
    "freshSchema refuses a database holding a table Vasal's schema does not create",
    async () => {
      await freshSchema(admin);
      await admin.query("CREATE TABLE public.not_vasal (x int)");
      await admin.query("INSERT INTO public.not_vasal VALUES (1)");
      await expect(freshSchema(admin)).rejects.toThrow(/tables Vasal's schema does not create/);
      const { rows } = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM public.not_vasal");
      expect(rows[0]?.n).toBe(1);
      await admin.query("DROP TABLE public.not_vasal");
    },
    RACE_TIMEOUT_MS,
  );
});
