/**
 * Returns a seeded generator of uniform numbers in [0, 1), using the
 * mulberry32 algorithm. The same seed always gives the same sequence on
 * every machine, which is what lets a published bootstrap be rerun and
 * matched byte for byte (threat model C9.3). It is not for secrets.
 *
 * Precondition: `seed` is an integer from 0 to 2^32 - 1.
 * Throws RangeError for any other seed.
 */
export function mulberry32(seed: number): () => number {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new RangeError("mulberry32 needs an integer seed from 0 to 2^32 - 1");
  }
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
