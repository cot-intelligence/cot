fn main() {
    // Declaring the app's commands generates a permission for each, so a
    // capability has to grant them. Only the bundled status page gets
    // `allow-retry-collector`; the dashboard page gets no app commands.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["retry_collector"])),
    )
    .expect("failed to run tauri build script");
}
