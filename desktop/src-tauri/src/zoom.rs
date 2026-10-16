//! Page zoom for the dashboard window: View > Zoom In / Zoom Out / Actual Size
//! (Cmd+= / Cmd+- / Cmd+0), stepping through Safari's levels. The level is
//! saved so the next launch opens at the same size.

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, WebviewWindow};

const LEVELS: [f64; 13] = [0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];
const ACTUAL: f64 = 1.0;

pub const ZOOM_IN: &str = "zoom-in";
pub const ZOOM_OUT: &str = "zoom-out";
pub const ZOOM_RESET: &str = "zoom-reset";

pub struct Zoom(Mutex<f64>);

impl Zoom {
    pub fn load(app: &AppHandle) -> Self {
        let level = file(app)
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|text| text.trim().parse::<f64>().ok())
            .filter(|level| (LEVELS[0]..=LEVELS[LEVELS.len() - 1]).contains(level))
            .unwrap_or(ACTUAL);
        Zoom(Mutex::new(level))
    }

    pub fn level(&self) -> f64 {
        *self.0.lock().unwrap()
    }
}

fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("zoom"))
}

/// The next level up (or down) from `current`, which may sit between levels.
fn step(current: f64, up: bool) -> f64 {
    const EPS: f64 = 1e-3;
    if up {
        LEVELS.iter().copied().find(|&l| l > current + EPS).unwrap_or(LEVELS[LEVELS.len() - 1])
    } else {
        LEVELS.iter().rev().copied().find(|&l| l < current - EPS).unwrap_or(LEVELS[0])
    }
}

/// Handles a View menu zoom item; returns false for any other menu id.
pub fn handle_menu(app: &AppHandle, window: Option<WebviewWindow>, id: &str) -> bool {
    let state = app.state::<Zoom>();
    let current = state.level();
    let next = match id {
        ZOOM_IN => step(current, true),
        ZOOM_OUT => step(current, false),
        ZOOM_RESET => ACTUAL,
        _ => return false,
    };
    *state.0.lock().unwrap() = next;
    if let Some(window) = window {
        let _ = window.set_zoom(next);
    }
    if let Some(path) = file(app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(path, next.to_string());
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_through_levels_and_clamps() {
        assert_eq!(step(1.0, true), 1.1);
        assert_eq!(step(1.0, false), 0.9);
        assert_eq!(step(3.0, true), 3.0);
        assert_eq!(step(0.5, false), 0.5);
        // Off-grid levels snap to the neighbouring step.
        assert_eq!(step(1.05, true), 1.1);
        assert_eq!(step(1.05, false), 1.0);
    }
}
