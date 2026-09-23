//! Traffic-light placement for the chromeless macOS window.
//!
//! The dashboard renders under the titlebar, so the window buttons have to sit
//! on the shell header's row instead of in the top 28pt AppKit gives them.
//! Tauri's `traffic_light_position` only moves them sideways and keeps
//! AppKit's vertical offset, which drifts with the button size of each macOS
//! release. This centres them on the row directly, as TitleBar.swift did.

use objc2_app_kit::{NSWindow, NSWindowButton};
use objc2_foundation::NSPoint;
use tauri::WebviewWindow;

/// The shell header is `h-14` (56px) with its controls vertically centred, so
/// its row's centre is 28px from the top of the window.
pub const ROW_CENTER_Y: f64 = 28.0;
/// Left edge of the close button.
pub const LEADING: f64 = 20.0;

/// Re-centre the buttons. AppKit lays the titlebar out again on resize, focus
/// and full-screen changes, so call this after each of those.
pub fn center_traffic_lights(window: &WebviewWindow) {
    let Ok(ptr) = window.ns_window() else { return };
    let ptr = ptr as usize;
    let _ = window.run_on_main_thread(move || {
        // SAFETY: the pointer is the live NSWindow of this webview window, and
        // AppKit is only touched here on the main thread.
        let ns_window = unsafe { &*(ptr as *const NSWindow) };
        place_buttons(ns_window);
    });
}

fn place_buttons(ns_window: &NSWindow) {
    let buttons = [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ]
    .map(|kind| ns_window.standardWindowButton(kind));
    let [Some(close), Some(miniaturize), Some(zoom)] = buttons else { return };
    let Some(titlebar) = (unsafe { close.superview() }) else { return };
    let Some(container) = (unsafe { titlebar.superview() }) else { return };

    // Grow the titlebar container so the row centre falls inside it.
    let height = ROW_CENTER_Y * 2.0;
    let mut frame = container.frame();
    frame.size.height = height;
    frame.origin.y = ns_window.frame().size.height - height;
    container.setFrame(frame);

    let spacing = miniaturize.frame().origin.x - close.frame().origin.x;
    let titlebar_height = titlebar.frame().size.height;
    for (i, button) in [close, miniaturize, zoom].iter().enumerate() {
        let button_height = button.frame().size.height;
        let y = if titlebar.isFlipped() {
            ROW_CENTER_Y - button_height / 2.0
        } else {
            // Unflipped: y counts up from the titlebar's bottom edge.
            titlebar_height - ROW_CENTER_Y - button_height / 2.0
        };
        button.setFrameOrigin(NSPoint::new(LEADING + i as f64 * spacing, y));
    }
}

/// Two-finger swipe for back and forward, as the Swift app had. Tauri doesn't
/// expose this WKWebView setting, so set it on the native view.
pub fn enable_swipe_navigation(window: &WebviewWindow) {
    let _ = window.with_webview(|webview| {
        let view = webview.inner() as *mut objc2::runtime::AnyObject;
        if view.is_null() {
            return;
        }
        // SAFETY: `inner()` is the window's live WKWebView, and with_webview
        // runs this on the main thread.
        unsafe {
            let _: () = objc2::msg_send![&*view, setAllowsBackForwardNavigationGestures: true];
        }
    });
}
