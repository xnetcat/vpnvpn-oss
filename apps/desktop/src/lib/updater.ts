import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

// Best-effort signed auto-update for the desktop app.
//
// Checks the configured GitHub Releases endpoint (latest.json) for a newer
// build, verifies its minisign signature against the public key bundled in
// tauri.conf.json, installs it, and relaunches. Any failure — running in a
// dev/web context where the Tauri updater is unavailable, being offline, or no
// release being published yet — is swallowed so it never blocks app startup.
export async function checkForUpdates(): Promise<void> {
  try {
    const update = await check();
    if (update?.available) {
      console.info(
        `[updater] update ${update.version} available; downloading and installing…`,
      );
      await update.downloadAndInstall();
      await relaunch();
    }
  } catch (err) {
    console.warn("[updater] update check skipped/failed:", err);
  }
}
