fn main() {
    // Declaring the app's commands generates a permission for each, so a
    // capability has to grant them. Only the bundled status page gets
    // `allow-retry-collector`; the dashboard only gets the three update
    // commands, which read the update state, check, and install on request.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["retry_collector", "update_state", "update_check", "update_install"])),
    )
    .expect("failed to run tauri build script");
}
