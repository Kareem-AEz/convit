// =============================================================================
// URL Helpers
// =============================================================================
//
// Small, dependency-free helpers shared by the git/model layer and the CLI.
// =============================================================================

/** Hostnames that mean "this machine" — data never leaves the box. */
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

/**
 * Returns true only when `url`'s host is a genuine loopback/local address.
 *
 * Parses the real hostname instead of substring-matching "localhost": a bare
 * `includes("localhost")` both false-positives `https://localhost.attacker.com`
 * and misses `::1` / `0.0.0.0`. IPv6 hosts arrive bracketed (`[::1]`) from the
 * URL parser, so the brackets are stripped before the allow-set check. A
 * malformed URL is treated as non-local (fail safe — assume data leaves).
 */
export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return LOCAL_HOSTNAMES.has(host);
  } catch {
    return false;
  }
}
