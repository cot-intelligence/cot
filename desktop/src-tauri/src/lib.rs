//! cot desktop shell: starts the frozen collector, shows the dashboard it
//! serves, and keeps both alive from the menu bar.

#[cfg(target_os = "macos")]
mod chrome;
mod collector;
mod updates;

use std::sync::atomic::{AtomicBool, Ordering};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use collector::{Bundle, Collector, CotHome, StartError};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::webview::DownloadEvent;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

const MAIN_WINDOW: &str = "main";

/// Runs in every page the window loads. On the dashboard it makes room for the
/// macOS traffic lights (placed by chrome.rs on the 56px top row) and turns the
/// top row into the window's drag handle.
///
/// The lights land in the sidebar's brand row, so the "cot." mark shifts right
/// of them and the "Intelligence" label is hidden. With the rail collapsed to
/// 56px the lights overhang it, so the page header is padded instead. The top
/// row reads as a titlebar: the header's breadcrumb is hidden and the rail's
/// divider starts below the row.
const CHROME_SCRIPT: &str = r#"
(function () {
  if (location.hostname !== '127.0.0.1' && location.hostname !== 'localhost') return;
  var CLEAR = 92, HEADER_PAD = 24;

  var init = function () {
    var style = document.createElement('style');
    style.textContent =
      '.cot-mac-brand{padding-left:' + CLEAR + 'px!important}' +
      '.cot-mac-brand .rail-label{display:none!important}' +
      // The top row is the titlebar: no breadcrumb, and the rail's divider
      // starts below it so nothing runs between the traffic lights.
      '.cot-mac-header nav[aria-label="Breadcrumb"]{visibility:hidden}' +
      '.cot-mac-rail{border-right-color:transparent!important}' +
      '.cot-mac-rail::after{content:"";position:absolute;top:56px;bottom:0;right:0;width:1px;' +
      'background:rgb(var(--line)/0.1);pointer-events:none}';
    document.head.appendChild(style);

    var mark = function () {
      var nav = document.querySelector('nav[aria-label="Primary"]');
      var brand = nav && nav.firstElementChild;
      var railWidth = 0;
      if (brand) {
        nav.classList.add('cot-mac-rail');
        brand.classList.add('cot-mac-brand');
        brand.setAttribute('data-tauri-drag-region', '');
        // The rail's layout box, not the nav, which widens over the page on hover.
        railWidth = nav.parentElement.getBoundingClientRect().width;
      }
      var header = null;
      var headers = document.querySelectorAll('header');
      for (var i = 0; i < headers.length; i++) {
        if (headers[i].getBoundingClientRect().top <= 1) { header = headers[i]; break; }
      }
      if (header) {
        header.classList.add('cot-mac-header');
        header.setAttribute('data-tauri-drag-region', '');
        var overhang = Math.max(0, CLEAR - railWidth);
        header.style.paddingLeft = overhang ? (overhang + HEADER_PAD) + 'px' : '';
      }
    };

    var queued = false;
    var schedule = function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { queued = false; mark(); });
    };
    // Routes swap the header out and the rail collapses by class, so watch both.
    new MutationObserver(schedule).observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['class']
    });
    window.addEventListener('resize', schedule);
    document.addEventListener('transitionend', schedule);
    mark();
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
"#;

#[derive(Clone, Debug, PartialEq)]
enum Status {
    Starting,
    Running { port: u16, version: String },
    PortHeld(u16),
    Failed(String),
    Stopped,
}

impl Status {
    fn summary(&self) -> String {
        match self {
            Status::Starting => "Starting collector…".into(),
            Status::Running { port, version } => format!("Running on {port} · v{version}"),
            Status::PortHeld(port) => format!("Port {port} is in use by another collector"),
            Status::Failed(_) => "Collector failed. See the window".into(),
            Status::Stopped => "Collector stopped".into(),
        }
    }

    fn port(&self) -> Option<u16> {
        match self {
            Status::Running { port, .. } => Some(*port),
            _ => None,
        }
    }
}

struct TrayItems {
    status: MenuItem<tauri::Wry>,
    copy_endpoint: MenuItem<tauri::Wry>,
    install_hooks: MenuItem<tauri::Wry>,
    repair_hooks: MenuItem<tauri::Wry>,
}

struct AppState {
    home: CotHome,
    collector: Mutex<Option<Collector>>,
    status: Mutex<Status>,
    /// Set while a start or restart is in flight, so tray clicks don't overlap.
    busy: AtomicBool,
    /// The window's own bundled page, used for the starting and error screens.
    local_page: Mutex<Option<Url>>,
    tray: Mutex<Option<TrayItems>>,
}

impl AppState {
    fn status(&self) -> Status {
        self.status.lock().unwrap().clone()
    }
}

/// Pages the window may show itself: the bundled status page and the local
/// collector. Everything else (docs, GitHub) opens in the user's browser.
fn is_internal_url(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "about" | "blob" | "data" => true,
        "http" | "https" => matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "tauri.localhost")),
        _ => false,
    }
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN_WINDOW)
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Point the window at whatever the current status calls for.
fn render_status(app: &AppHandle) {
    let state = app.state::<AppState>();
    let status = state.status();
    let Some(window) = main_window(app) else { return };

    let target = match &status {
        Status::Running { port, .. } => Url::parse(&format!("http://127.0.0.1:{port}/")).ok(),
        other => state.local_page.lock().unwrap().clone().map(|mut url| {
            {
                let mut query = url.query_pairs_mut();
                query.clear();
                match other {
                    Status::Starting => query.append_pair("state", "starting"),
                    Status::PortHeld(port) => {
                        query.append_pair("state", "held").append_pair("port", &port.to_string())
                    }
                    Status::Failed(message) => {
                        query.append_pair("state", "failed").append_pair("message", message)
                    }
                    _ => query.append_pair("state", "stopped"),
                };
            }
            url
        }),
    };
    if let Some(url) = target {
        let _ = window.navigate(url);
    }
    refresh_tray(app);
}

fn refresh_tray(app: &AppHandle) {
    let state = app.state::<AppState>();
    let status = state.status();
    let serving = status.port().is_some();
    if let Some(items) = state.tray.lock().unwrap().as_ref() {
        let _ = items.status.set_text(status.summary());
        let _ = items.copy_endpoint.set_enabled(serving);
        let _ = items.install_hooks.set_enabled(serving);
        let _ = items.repair_hooks.set_enabled(serving);
    }
    sync_tray_glyph(app);
}

fn set_status(app: &AppHandle, status: Status) {
    *app.state::<AppState>().status.lock().unwrap() = status;
    render_status(app);
}

fn resolve_bundle(app: &AppHandle) -> Bundle {
    let resources = app.path().resource_dir().unwrap_or_default();
    Bundle {
        binary: resources.join("cot-collector").join("cot-collector"),
        static_dir: resources.join("static"),
    }
}

/// Stop whatever is running, then start fresh. Runs off the main thread: the
/// startup wait can take seconds.
fn restart_collector(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.busy.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        stop_collector(&app);
        set_status(&app, Status::Starting);

        let state = app.state::<AppState>();
        let status = match Collector::start(&state.home, &resolve_bundle(&app)) {
            Ok(collector) => {
                let status = Status::Running { port: collector.port, version: collector.version.clone() };
                *state.collector.lock().unwrap() = Some(collector);
                status
            }
            Err(StartError::PortHeld(port)) => Status::PortHeld(port),
            Err(StartError::Failed(message)) => Status::Failed(message),
        };
        set_status(&app, status);
        state.busy.store(false, Ordering::SeqCst);
    });
}

fn stop_collector(app: &AppHandle) {
    let state = app.state::<AppState>();
    let taken = state.collector.lock().unwrap().take();
    if let Some(mut collector) = taken {
        collector.stop(&state.home);
    }
    *state.status.lock().unwrap() = Status::Stopped;
}

/// Notice a collector that dies after startup, so the window and tray say so
/// instead of showing a dead page.
fn watch_collector(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(2));
        let state = app.state::<AppState>();
        let exited = {
            let mut guard = state.collector.lock().unwrap();
            let exited = guard.as_mut().is_some_and(Collector::has_exited);
            if exited {
                guard.take();
            }
            exited
        };
        if exited {
            let _ = std::fs::remove_file(state.home.pid_file());
            let log = state.home.log_file();
            set_status(&app, Status::Failed(format!("Collector exited. See {}", log.display())));
        }
    });
}

/// Runs the same install.sh the curl path uses, served by our collector.
/// Interactive prompts need a terminal, so it opens in Terminal.app.
fn run_hook_installer(port: u16, repair: bool) {
    let mut command = format!("COT_ENDPOINT=http://127.0.0.1:{port} curl -fsSL http://127.0.0.1:{port}/install.sh | sh");
    if repair {
        command.push_str(" -s -- --repair");
    }
    let escaped = command.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!("tell application \"Terminal\"\n  activate\n  do script \"{escaped}\"\nend tell");
    let _ = std::process::Command::new("/usr/bin/osascript").arg("-e").arg(script).spawn();
}

/// The menu-bar "cot." pill: filled while the collector serves, outlined
/// otherwise. Template images, so macOS tints them to match the menu bar.
/// Regenerate with scripts/make-tray-icons.swift.
fn tray_glyph(serving: bool) -> Image<'static> {
    let png: &'static [u8] = if serving {
        include_bytes!("../icons/tray/cot-on.png")
    } else {
        include_bytes!("../icons/tray/cot-off.png")
    };
    Image::from_bytes(png).expect("bundled tray icon is a valid PNG")
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, "status", "Starting collector…", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open Dashboard", true, None::<&str>)?;
    let copy_endpoint = MenuItem::with_id(app, "copy-endpoint", "Copy Endpoint", false, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "Restart Collector", true, None::<&str>)?;
    let install_hooks = MenuItem::with_id(app, "install-hooks", "Install Agent Hooks…", false, None::<&str>)?;
    let repair_hooks = MenuItem::with_id(app, "repair-hooks", "Repair Agent Hooks…", false, None::<&str>)?;
    let reveal = MenuItem::with_id(app, "reveal-data", "Reveal Data Folder", true, None::<&str>)?;
    let open_log = MenuItem::with_id(app, "open-log", "Open Collector Log", true, None::<&str>)?;
    let at_login = app.autolaunch().is_enabled().unwrap_or(false);
    let login = CheckMenuItem::with_id(app, "login", "Start cot at Login", true, at_login, None::<&str>)?;
    let updates = MenuItem::with_id(app, "check-updates", "Check for Updates…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit cot", true, Some("CmdOrCtrl+Q"))?;

    let sep = || PredefinedMenuItem::separator(app);
    let menu = Menu::with_items(
        app,
        &[
            &status, &sep()?, &open, &copy_endpoint, &sep()?, &restart, &sep()?, &install_hooks,
            &repair_hooks, &reveal, &open_log, &login, &sep()?, &updates, &quit,
        ],
    )?;

    let login_item = login.clone();
    TrayIconBuilder::with_id("cot")
        .icon(tray_glyph(false))
        .icon_as_template(true)
        .tooltip("cot")
        .menu(&menu)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "copy-endpoint" => {
                if let Some(port) = app.state::<AppState>().status().port() {
                    let _ = app.clipboard().write_text(format!("http://127.0.0.1:{port}"));
                }
            }
            "restart" => restart_collector(app),
            "install-hooks" | "repair-hooks" => {
                if let Some(port) = app.state::<AppState>().status().port() {
                    run_hook_installer(port, event.id().as_ref() == "repair-hooks");
                }
            }
            "reveal-data" => {
                let state = app.state::<AppState>();
                let db = state.home.database_file();
                let target = if db.exists() { db } else { state.home.dir().to_path_buf() };
                let _ = app.opener().reveal_item_in_dir(target);
            }
            "open-log" => {
                let log = app.state::<AppState>().home.log_file();
                let _ = app.opener().open_path(log.to_string_lossy(), None::<&str>);
            }
            "login" => {
                let autolaunch = app.autolaunch();
                let want = !autolaunch.is_enabled().unwrap_or(false);
                let _ = if want { autolaunch.enable() } else { autolaunch.disable() };
                let _ = login_item.set_checked(autolaunch.is_enabled().unwrap_or(false));
            }
            "check-updates" => updates::check(app.clone(), true),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    *app.state::<AppState>().tray.lock().unwrap() =
        Some(TrayItems { status, copy_endpoint, install_hooks, repair_hooks });
    Ok(())
}

/// Swap the tray glyph whenever the status line changes.
fn sync_tray_glyph(app: &AppHandle) {
    let serving = app.state::<AppState>().status().port().is_some();
    if let Some(tray) = app.tray_by_id("cot") {
        let _ = tray.set_icon(Some(tray_glyph(serving)));
        let _ = tray.set_icon_as_template(true);
    }
}

/// Adds Reload Dashboard (Cmd+R) to the standard macOS View menu.
fn build_app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    let reload = MenuItem::with_id(app, "reload", "Reload Dashboard", true, Some("CmdOrCtrl+R"))?;
    for item in menu.items()? {
        if let MenuItemKind::Submenu(submenu) = item {
            if submenu.text()? == "View" {
                submenu.prepend(&reload)?;
            }
        }
    }
    Ok(menu)
}

fn build_main_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let nav_app = app.clone();
    let popup_app = app.clone();
    let download_app = app.clone();
    // Where each download landed, by URL: on macOS the Finished event doesn't say.
    let downloads: Arc<Mutex<HashMap<String, PathBuf>>> = Arc::default();
    let builder = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
        .title("cot")
        .inner_size(1280.0, 860.0)
        .min_inner_size(900.0, 600.0)
        .initialization_script(CHROME_SCRIPT)
        .on_navigation(move |url| {
            if is_internal_url(url) {
                // Swiping back past the dashboard would reach the "Starting…"
                // page from launch, which is stale once the collector is up.
                let is_status_page = url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost");
                let running = nav_app.state::<AppState>().status().port().is_some();
                return !(is_status_page && running);
            }
            let _ = nav_app.opener().open_url(url.as_str(), None::<&str>);
            false
        })
        .on_new_window(move |url, _features| {
            // target="_blank" links and window.open: always the browser.
            let _ = popup_app.opener().open_url(url.as_str(), None::<&str>);
            tauri::webview::NewWindowResponse::Deny
        })
        // Without a handler WebKit cancels `<a download>` links (the sessions
        // page's JSON export). Keep WebKit's pick of ~/Downloads, which never
        // overwrites, and show the file in Finder since there's no download bar.
        .on_download(move |_webview, event| {
            match event {
                DownloadEvent::Requested { url, destination } => {
                    if let Ok(mut map) = downloads.lock() {
                        map.insert(url.to_string(), destination.clone());
                    }
                }
                DownloadEvent::Finished { url, success, .. } => {
                    let path = downloads.lock().ok().and_then(|mut map| map.remove(url.as_str()));
                    if let (true, Some(path)) = (success, path) {
                        let _ = download_app.opener().reveal_item_in_dir(path);
                    }
                }
                _ => {}
            }
            true
        });

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    let window = builder.build()?;
    #[cfg(target_os = "macos")]
    {
        chrome::center_traffic_lights(&window);
        chrome::enable_swipe_navigation(&window);
    }

    let handle = window.clone();
    window.on_window_event(move |event| match event {
        // The collector outlives the window: closing it keeps traces flowing.
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = handle.hide();
        }
        // AppKit re-lays out the titlebar on these and resets the buttons.
        #[cfg(target_os = "macos")]
        WindowEvent::Resized(_) | WindowEvent::Focused(_) | WindowEvent::ScaleFactorChanged { .. } | WindowEvent::ThemeChanged(_) => {
            chrome::center_traffic_lights(&handle);
        }
        _ => {}
    });
    Ok(window)
}

/// Called by the bundled status page's "Try again" button. It is only granted
/// to the local page, never to the dashboard (see capabilities/).
#[tauri::command]
fn retry_collector(app: AppHandle) {
    restart_collector(&app);
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main_window(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState {
            home: CotHome::from_env(),
            collector: Mutex::new(None),
            status: Mutex::new(Status::Starting),
            busy: AtomicBool::new(false),
            local_page: Mutex::new(None),
            tray: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![retry_collector])
        .menu(|app| build_app_menu(app))
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "reload" {
                if let Some(window) = main_window(app) {
                    let _ = window.eval("location.reload()");
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let window = build_main_window(&handle)?;
            *handle.state::<AppState>().local_page.lock().unwrap() = window.url().ok();
            build_tray(&handle)?;
            watch_collector(handle.clone());
            restart_collector(&handle);
            updates::schedule(handle);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building cot");

    app.run(|app, event| match event {
        // Dock icon clicked while the window is hidden.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main_window(app),
        RunEvent::Exit => stop_collector(app),
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn internal(url: &str) -> bool {
        is_internal_url(&Url::parse(url).unwrap())
    }

    #[test]
    fn navigation_stays_on_the_local_collector() {
        assert!(internal("http://127.0.0.1:31337/"));
        assert!(internal("http://127.0.0.1:31340/#/sessions"));
        assert!(internal("http://localhost:4000/"));
        assert!(internal("tauri://localhost/index.html?state=starting"));
        assert!(internal("http://tauri.localhost/index.html"));
        assert!(internal("about:blank"));
        assert!(internal("blob:http://127.0.0.1:31337/abc"));
    }

    #[test]
    fn everything_else_goes_to_the_browser() {
        assert!(!internal("https://cot.run/docs"));
        assert!(!internal("https://github.com/cot-intelligence/cot"));
        assert!(!internal("http://127.0.0.2:31337/"));
        assert!(!internal("http://localhost.evil.com/"));
        assert!(!internal("file:///etc/passwd"));
        assert!(!internal("mailto:hi@cot.run"));
    }
}
