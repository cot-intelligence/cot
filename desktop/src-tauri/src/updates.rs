//! Self-update from the platforms block of https://cot.run/version.json.
//!
//! Checks on launch, every 6 hours, and from the tray. An update is only
//! installed after the user confirms; the collector is stopped between the
//! download and the install so the database closes cleanly.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

static CHECKING: AtomicBool = AtomicBool::new(false);

/// Background checks on launch and every 6 hours. Skipped in debug builds,
/// whose 0.0.0 version would always look out of date.
pub fn schedule(app: AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    std::thread::spawn(move || loop {
        check(app.clone(), false);
        std::thread::sleep(CHECK_INTERVAL);
    });
}

/// `interactive` is true when the user asked (tray item): they get told about
/// "no update" and errors too. Background checks stay quiet unless an update
/// is found.
pub fn check(app: AppHandle, interactive: bool) {
    if CHECKING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        run_check(&app, interactive);
        CHECKING.store(false, Ordering::SeqCst);
    });
}

fn run_check(app: &AppHandle, interactive: bool) {
    let found = tauri::async_runtime::block_on(async {
        app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())
    });

    let update = match found {
        Ok(Some(update)) => update,
        Ok(None) => {
            if interactive {
                let version = app.package_info().version.to_string();
                app.dialog()
                    .message(format!("cot {version} is the latest version."))
                    .title("You're up to date")
                    .blocking_show();
            }
            return;
        }
        Err(error) => {
            if interactive {
                app.dialog()
                    .message(format!("Could not check for updates.\n\n{error}"))
                    .title("Update check failed")
                    .kind(MessageDialogKind::Error)
                    .blocking_show();
            }
            return;
        }
    };

    let notes = update.body.clone().unwrap_or_default();
    let prompt = if notes.trim().is_empty() {
        format!("cot {} is available. Install and restart?", update.version)
    } else {
        format!("cot {} is available. Install and restart?\n\n{}", update.version, notes.trim())
    };
    let confirmed = app
        .dialog()
        .message(prompt)
        .title("Update available")
        .buttons(MessageDialogButtons::OkCancelCustom("Install and Restart".into(), "Later".into()))
        .blocking_show();
    if !confirmed {
        return;
    }

    let bytes = match tauri::async_runtime::block_on(update.download(|_, _| {}, || {})) {
        Ok(bytes) => bytes,
        Err(error) => {
            app.dialog()
                .message(format!("The update could not be downloaded.\n\n{error}"))
                .title("Update failed")
                .kind(MessageDialogKind::Error)
                .blocking_show();
            return;
        }
    };

    crate::stop_collector(app);
    if let Err(error) = update.install(bytes) {
        app.dialog()
            .message(format!("The update could not be installed.\n\n{error}"))
            .title("Update failed")
            .kind(MessageDialogKind::Error)
            .blocking_show();
        crate::restart_collector(app);
        return;
    }
    app.restart();
}
