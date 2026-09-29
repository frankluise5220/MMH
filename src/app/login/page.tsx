import { headers } from "next/headers";
import { LoginPageClient } from "./LoginPageClient";

/**
 * fnOS unified-gateway identity, forwarded by fnOS when this app runs behind
 * the gateway (X-Trim-* headers). Absent on Docker / Synology / direct access,
 * which keeps the fnOS login mode hidden there.
 */
export interface FnosGatewayUser {
  uid: string;
  username: string | null;
  isAdmin: boolean;
}

export default async function LoginPage() {
  const h = await headers();
  const gateway: FnosGatewayUser | null = (() => {
    const uid = h.get("x-trim-userid");
    if (!uid) return null;
    return {
      uid,
      username: h.get("x-trim-username"),
      isAdmin: h.get("x-trim-isadmin") === "true",
    };
  })();
  return <LoginPageClient householdName={null} fnosGatewayUser={gateway} />;
}
