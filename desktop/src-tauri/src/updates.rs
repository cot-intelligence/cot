//! Self-update from the platforms block of https://cot.run/version.json.
//!
//! Checks on launch, every 6 hours, and from the tray or Settings → About. The
//! result lives here and the dashboard reads it (`update_state`) to show its
//! update card and the About tab, so there are no native dialogs. An update is
//! only installed when the user asks; the collector is stopped between the
//! download and the install so the database closes cleanly.

use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::menu::MenuItem;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_updater::{Update, UpdaterExt};

const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const TRAY_LABEL: &str = "Check for Updates…";

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Idle,
    Checking,
    Current,
    Available,
    Downloading,
    Installing,
    Failed,
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Phase::Idle => "idle",
            Phase::Checking => "checking",
            Phase::Current => "current",
            Phase::Available => "available",
            Phase::Downloading => "downloading",
            Phase::Installing => "installing",
            Phase::Failed => "failed",
        }
    }
}

struct State {
    phase: Phase,
    version: Option<String>,
    notes: Option<String>,
    error: Option<String>,
    downloaded: u64,
    total: Option<u64>,
}

pub struct Updates {
    state: Mutex<State>,
    pending: Mutex<Option<Update>>,
    tray_item: Mutex<Option<MenuItem<Wry>>>,
}

impl Default for Updates {
    fn default() -> Self {
        Self {
            state: Mutex::new(State { phase: Phase::Idle, version: None, notes: None, error: None, downloaded: 0, total: None }),
            pending: Mutex::new(None),
            tray_item: Mutex::new(None),
        }
    }
}

fn updates(app: &AppHandle) -> &Updates {
    app.state::<Updates>().inner()
}

fn busy(app: &AppHandle) -> bool {
    matches!(updates(app).state.lock().unwrap().phase, Phase::Checking | Phase::Downloading | Phase::Installing)
}

fn snapshot(app: &AppHandle) -> Value {
    let s = updates(app).state.lock().unwrap();
    json!({
        "status": s.phase.name(),
        "current": app.package_info().version.to_string(),
        "version": s.version,
        "notes": s.notes,
        "error": s.error,
        "downloaded": s.downloaded,
        "total": s.total,
    })
}

/// The tray item reads "Update to cot x…" while one is waiting.
pub fn set_tray_item(app: &AppHandle, item: MenuItem<Wry>) {
    *updates(app).tray_item.lock().unwrap() = Some(item);
}

fn set_tray_label(app: &AppHandle, version: Option<&str>) {
    if let Some(item) = updates(app).tray_item.lock().unwrap().as_ref() {
        let _ = item.set_text(version.map_or_else(|| TRAY_LABEL.to_string(), |v| format!("Update to cot {v}…")));
    }
}

/// Background checks on launch and every 6 hours. Skipped in debug builds,
/// whose 0.0.0 version would always look out of date.
pub fn schedule(app: AppHandle) {
    if cfg!(debug_assertions) || crate::sandbox::enabled() {
        return;
    }
    std::thread::spawn(move || loop {
        tauri::async_runtime::block_on(check_now(&app, false));
        std::thread::sleep(CHECK_INTERVAL);
    });
}

/// `interactive` is true when the user asked: a failed check is then shown.
/// A failed background check stays quiet and keeps an update already found.
async fn check_now(app: &AppHandle, interactive: bool) {
    if crate::sandbox::enabled() || busy(app) {
        return;
    }
    {
        let mut s = updates(app).state.lock().unwrap();
        if interactive || s.phase != Phase::Available {
            s.phase = Phase::Checking;
            s.error = None;
        }
    }
    let found = match app.updater() {
        Ok(updater) => updater.check().await.map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    };
    let mut s = updates(app).state.lock().unwrap();
    match found {
        Ok(Some(update)) => {
            s.phase = Phase::Available;
            s.version = Some(update.version.clone());
            s.notes = update.body.clone().filter(|n| !n.trim().is_empty());
            s.error = None;
            set_tray_label(app, Some(&update.version));
            *updates(app).pending.lock().unwrap() = Some(update);
        }
        Ok(None) => {
            s.phase = Phase::Current;
            s.version = None;
            s.notes = None;
            set_tray_label(app, None);
            *updates(app).pending.lock().unwrap() = None;
        }
        // A background check that fails while an update is waiting leaves it be.
        Err(_) if s.phase == Phase::Available => {}
        Err(error) => {
            s.phase = Phase::Failed;
            s.error = Some(error);
        }
    }
}

/// Tray item: open Settings → About, which shows the check as it runs.
pub fn open_and_check(app: &AppHandle) {
    crate::show_settings_tab(app, "about");
    let app = app.clone();
    tauri::async_runtime::spawn(async move { check_now(&app, true).await });
}

#[tauri::command]
pub fn update_state(app: AppHandle) -> Value {
    snapshot(&app)
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Value {
    check_now(&app, true).await;
    snapshot(&app)
}

/// Downloads and installs the update found by the last check, then restarts.
/// The dashboard follows the progress through `update_state`.
#[tauri::command]
pub fn update_install(app: AppHandle) -> Result<(), String> {
    if busy(&app) {
        return Err("An update is already in progress.".into());
    }
    let update = updates(&app).pending.lock().unwrap().clone().ok_or("No update to install. Check for updates first.")?;
    {
        let mut s = updates(&app).state.lock().unwrap();
        s.phase = Phase::Downloading;
        s.error = None;
        s.downloaded = 0;
        s.total = None;
    }
    tauri::async_runtime::spawn(async move {
        let progress = app.clone();
        let downloaded = update
            .download(
                move |chunk, total| {
                    let mut s = updates(&progress).state.lock().unwrap();
                    s.downloaded += chunk as u64;
                    s.total = total;
                },
                || {},
            )
            .await;
        let fail = |error: String| {
            let mut s = updates(&app).state.lock().unwrap();
            s.phase = Phase::Failed;
            s.error = Some(error);
        };
        let bytes = match downloaded {
            Ok(bytes) => bytes,
            Err(error) => return fail(format!("The update could not be downloaded. {error}")),
        };
        updates(&app).state.lock().unwrap().phase = Phase::Installing;
        crate::stop_collector(&app);
        if let Err(error) = update.install(bytes) {
            crate::restart_collector(&app);
            return fail(format!("The update could not be installed. {error}"));
        }
        app.restart();
    });
    Ok(())
}
