import { NextResponse } from "next/server";

import { getSettingsCatalogForSurface, getSettingsCatalogWithoutHiddenItems, type SettingsSurface } from "@/lib/settings/catalog";
import { shouldShowSponsor } from "@/lib/server/sponsor-visibility";

/**
 * GET /api/v1/settings/catalog?surface=web|android
 *
 * Returns the shared settings catalog used by Web and Android.
 * The "sponsor" entry is revealed only when the server-side visibility
 * condition holds (see src/lib/server/sponsor-visibility.ts); hidden entries
 * are stripped on every branch, including the surface-less fallback.
 *
 * Success: { ok: true, data: SettingsCatalog }
 * Failure: { ok: false, error: string }
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const surface = url.searchParams.get("surface");

  if (!surface) {
    return NextResponse.json({ ok: true, data: getSettingsCatalogWithoutHiddenItems() });
  }

  if (surface !== "web" && surface !== "android") {
    return NextResponse.json({ ok: false, code: "INVALID_SURFACE", error: "surface must be web or android" }, { status: 400 });
  }

  const showSponsor = await shouldShowSponsor();
  return NextResponse.json({ ok: true, data: getSettingsCatalogForSurface(surface as SettingsSurface, showSponsor ? ["sponsor"] : undefined) });
}
