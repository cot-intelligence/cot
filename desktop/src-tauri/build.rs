fn main() {
    // Declaring the app's commands generates a permission for each, so a
    // capability has to grant them. Only the bundled status page gets
    // `allow-retry-collector`; the dashboard only gets `allow-check-for-updates`,
    // which opens the app's update dialogs and installs nothing unconfirmed.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["retry_collector", "check_for_updates"])),
    )
    .expect("failed to run tauri build script");
}
