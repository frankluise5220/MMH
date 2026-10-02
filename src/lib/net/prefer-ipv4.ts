import dns from "node:dns";

/**
 * Prefer IPv4 when resolving outbound hostnames.
 *
 * Node's default result order is "verbatim", so a host that publishes AAAA
 * records is dialled over IPv6 first. On the consumer networks this app is
 * deployed to (home NAS, dev boxes behind a home router) IPv6 egress is often
 * broken in a specific way: the TCP connect *succeeds* and the peer then resets
 * the connection, which surfaces as ECONNRESET / "fetch failed". Because the
 * socket was established rather than refused, Happy Eyeballs never falls back
 * to IPv4 and the whole request dies. api.resend.com (Cloudflare) is a repeat
 * offender here — mail then fails with "连接 Resend 失败".
 *
 * "ipv4first" only reorders the list: AAAA records stay in it, so a genuinely
 * IPv6-only network still resolves and connects.
 *
 * This module applies the setting on import (idempotent), so any outbound HTTP
 * module can pull it in with a side-effect import. `instrumentation-node.ts`
 * also calls it, but relying on instrumentation alone is not enough: it runs
 * once per process, so a running server (e.g. `next dev` with HMR) keeps the
 * old resolver order until it is restarted — which is exactly how a fix can
 * look "not implemented" while the error message already reflects newer code.
 */
let applied = false;

export function preferIpv4Dns() {
  if (applied) return;
  applied = true;
  try {
    dns.setDefaultResultOrder("ipv4first");
  } catch (error) {
    // Never let a resolver tweak take the process down; the request will just
    // behave as before.
    console.error("[net] could not set DNS result order to ipv4first:", error);
  }
}

preferIpv4Dns();
