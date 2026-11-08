import { redirect } from "next/navigation";

/**
 * The standalone scheduled-task settings page was merged into the
 * personalization page (/settings/display) on 2026-11-08. Keep this redirect
 * so old bookmarks and links keep working.
 */
export default function ScheduledTaskSettingsPage() {
  redirect("/settings/display");
}
