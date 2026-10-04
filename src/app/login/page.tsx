import { headers } from "next/headers";
import { LoginPageClient } from "./LoginPageClient";

/**
 * fnOS unified-gateway identity, forwarded by fnOS when this app runs behind
 * the gateway (X-Trim-* headers). Absent on Docker / Synology / direct access,
 * which keeps the fnOS login mode hidden there.
 *
 * `username` (X-Trim-Username, e.g. `jsbyfubin`) is the login account name the
 * user actually sees in fnOS and is the primary identity; `uid`
 * (X-Trim-Userid, e.g. `1001`) is the internal numeric id and only a fallback.
 */
export interface FnosGatewayUser {
  uid: string;
  username: string | null;
  isAdmin: boolean;
}

export default async function LoginPage() {
  const h = await headers();
  const gateway: FnosGatewayUser | null = (() => {
    const uid = h.get("x-trim-userid")?.trim() ?? "";
    const username = h.get("x-trim-username")?.trim() ?? "";
    if (!uid && !username) return null;
    return {
      uid,
      username: username || null,
      isAdmin: h.get("x-trim-isadmin") === "true",
    };
  })();
  return <LoginPageClient householdName={null} fnosGatewayUser={gateway} />;
}
