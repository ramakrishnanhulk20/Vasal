import { createHmac } from "node:crypto";
import ipaddr from "ipaddr.js";

const MIN_SECRET_LENGTH = 32;
// Longest real form is an IPv6 address with a zone id; anything far past that
// is not an address and is refused before the parser sees it.
const MAX_ADDRESS_LENGTH = 100;

/**
 * The one visitor identity, used both when counting and when checking, so
 * the two can never disagree (C5.3). The address is parsed with
 * ipaddr.process, which folds `::ffff:1.2.3.4` and other IPv4 spellings into
 * plain IPv4. IPv4 keys on the full address; IPv6 keys on its first 64 bits,
 * so rotating inside one /64 does not make a new visitor. Returns the hex
 * HMAC-SHA256 of that canonical form under `secret`, so the raw address is
 * never stored (C6.8). Returns null when the address does not parse or the
 * secret is shorter than 32 characters; callers treat null as a refusal.
 * Expects the address from the header the hosting edge sets, never one the
 * client chose.
 */
export function visitorKey(rawAddress: string, secret: string): string | null {
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) return null;
  if (typeof rawAddress !== "string" || rawAddress.length > MAX_ADDRESS_LENGTH) return null;

  let address: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    address = ipaddr.process(rawAddress.trim());
  } catch {
    return null;
  }

  // The family prefix keeps an IPv4 key from ever equalling an IPv6 one.
  const canonical =
    address.kind() === "ipv4"
      ? `ipv4:${address.toByteArray().join(".")}`
      : `ipv6/64:${Buffer.from(address.toByteArray().slice(0, 8)).toString("hex")}`;
  return createHmac("sha256", secret).update(canonical).digest("hex");
}
