import ipaddr from "ipaddr.js";

export type AddressCheck = (address: string) => boolean;

/**
 * True only for public unicast internet space. ipaddr.process folds
 * IPv4-mapped IPv6 back to IPv4 first, so `::ffff:127.0.0.1` is judged as
 * loopback. Covers loopback, private, link-local (169.254.169.254), carrier
 * NAT, unique-local IPv6, multicast, unspecified, reserved and NAT64. Does not
 * cover public addresses that trust this server's IP (threat model C1.1, C1.2).
 * Anything that fails to parse is refused.
 */
export const isPublicUnicast: AddressCheck = (address) => {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
};
