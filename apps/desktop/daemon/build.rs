//! Build script for the vpnVPN daemon.

fn main() {
    println!("cargo:rerun-if-env-changed=VPNVPN_EXPECTED_TEAM_ID");

    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let profile = std::env::var("PROFILE").unwrap_or_default();
    let team_id = std::env::var("VPNVPN_EXPECTED_TEAM_ID").unwrap_or_default();
    let allow_unpinned = std::env::var("VPNVPN_ALLOW_UNPINNED_TEAM_ID").is_ok();

    if target_os == "macos" && profile == "release" && team_id.trim().is_empty() && !allow_unpinned
    {
        panic!(
            "VPNVPN_EXPECTED_TEAM_ID must be set for macOS release builds so the \
             daemon pins the expected code-signing Team ID for IPC client \
             verification. Set it in the release/CI environment, or set \
             VPNVPN_ALLOW_UNPINNED_TEAM_ID=1 for a compile-only check."
        );
    }
}
