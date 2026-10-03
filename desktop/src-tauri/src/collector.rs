//! Where the collector lives and how its process is started and stopped.
//!
//! Ported from macos/Sources/CollectorController.swift and
//! CollectorEndpoint.swift. The rules are the same with one change: if another
//! collector already answers on the port, the app refuses to start rather than
//! attaching to it, so there is never a second writer on ~/.cot/cot.db.

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub const DEFAULT_PORT: u16 = 31337;
const PORT_ATTEMPTS: u16 = 32;
/// uvicorn binds in well under a second, but a cold frozen binary loads a lot
/// of Python first.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(15);
/// Time uvicorn gets to close SQLite cleanly before SIGKILL.
const STOP_GRACE: Duration = Duration::from_secs(5);

/// The ~/.cot home the Docker install and the bridge already use.
#[derive(Clone, Debug)]
pub struct CotHome(PathBuf);

impl CotHome {
    pub fn from_env() -> Self {
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
        CotHome(home.join(".cot"))
    }

    pub fn dir(&self) -> &Path {
        &self.0
    }
    pub fn config_file(&self) -> PathBuf {
        self.0.join("config.json")
    }
    pub fn database_file(&self) -> PathBuf {
        self.0.join("cot.db")
    }
    pub fn log_file(&self) -> PathBuf {
        self.0.join("logs").join("collector.log")
    }
    /// PID of the collector this app spawned, so a crashed or force-quit app
    /// doesn't leave one running against the database.
    pub fn pid_file(&self) -> PathBuf {
        self.0.join("app-collector.pid")
    }

    /// Port recorded by a previous install, so hooks wired to a non-default
    /// port keep working. `COT_PORT` overrides it for testing.
    pub fn preferred_port(&self, env_port: Option<&str>) -> u16 {
        if let Some(port) = env_port.and_then(|p| p.trim().parse().ok()) {
            return port;
        }
        fs::read_to_string(self.config_file())
            .ok()
            .and_then(|raw| port_from_config(&raw))
            .unwrap_or(DEFAULT_PORT)
    }

    /// Point the bridge at the port we ended up on. Hooks read this file on
    /// every event, so writing it is what makes a non-default port work.
    pub fn save_endpoint(&self, port: u16) -> std::io::Result<()> {
        fs::create_dir_all(&self.0)?;
        let body = format!("{{\"endpoint\": \"http://127.0.0.1:{port}\"}}\n");
        let tmp = self.0.join("config.json.tmp");
        fs::write(&tmp, body)?;
        fs::rename(tmp, self.config_file())
    }
}

/// The port in `{"endpoint": "http://127.0.0.1:31337"}`.
pub fn port_from_config(raw: &str) -> Option<u16> {
    let json: serde_json::Value = serde_json::from_str(raw).ok()?;
    let endpoint = json.get("endpoint")?.as_str()?;
    let after_scheme = endpoint.split_once("://").map_or(endpoint, |(_, rest)| rest);
    let authority = after_scheme.split('/').next()?;
    let (_, port) = authority.rsplit_once(':')?;
    port.parse().ok()
}

pub fn parse_pid(raw: &str) -> Option<i32> {
    raw.trim().parse().ok().filter(|pid: &i32| *pid > 0)
}

/// True when nothing holds the port on the loopback interface.
pub fn is_port_free(port: u16) -> bool {
    TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).is_ok()
}

/// First free port at or after `start`, matching the installer's behaviour.
pub fn first_free_port(start: u16, is_free: impl Fn(u16) -> bool) -> Option<u16> {
    (0..PORT_ATTEMPTS)
        .filter_map(|offset| start.checked_add(offset))
        .find(|port| is_free(*port))
}

/// Version reported by a collector already answering `/health` on `port`.
///
/// A raw HTTP/1.0 GET over TcpStream: the collector is local and the response
/// is a few bytes of JSON, which is not worth an HTTP client dependency.
pub fn health(port: u16) -> Option<String> {
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port).into();
    let timeout = Duration::from_millis(1500);
    let mut stream = TcpStream::connect_timeout(&addr, timeout).ok()?;
    stream.set_read_timeout(Some(timeout)).ok()?;
    stream.set_write_timeout(Some(timeout)).ok()?;
    stream
        .write_all(b"GET /health HTTP/1.0\r\nHost: 127.0.0.1\r\nAccept: application/json\r\n\r\n")
        .ok()?;
    let mut response = Vec::new();
    stream.take(64 * 1024).read_to_end(&mut response).ok()?;
    parse_health_response(&String::from_utf8_lossy(&response))
}

pub fn parse_health_response(response: &str) -> Option<String> {
    let (head, body) = response.split_once("\r\n\r\n")?;
    let status_line = head.lines().next()?;
    if status_line.split_whitespace().nth(1) != Some("200") {
        return None;
    }
    let json: serde_json::Value = serde_json::from_str(body.trim()).ok()?;
    if json.get("status")?.as_str()? != "ok" {
        return None;
    }
    Some(json.get("version").and_then(|v| v.as_str()).unwrap_or("unknown").to_string())
}

fn process_alive(pid: i32) -> bool {
    // kill(pid, 0) only probes; ESRCH means the process is already gone.
    unsafe { libc::kill(pid, 0) == 0 }
}

/// SIGTERM, a grace period, then SIGKILL.
fn terminate_pid(pid: i32) {
    unsafe { libc::kill(pid, libc::SIGTERM) };
    let deadline = Instant::now() + STOP_GRACE;
    while process_alive(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    if process_alive(pid) {
        unsafe { libc::kill(pid, libc::SIGKILL) };
    }
}

/// A collector we spawned that outlived its app (force quit, crash, SIGKILL).
/// Take it down before claiming the port.
pub fn reap_orphan(home: &CotHome) {
    let pid_file = home.pid_file();
    let Some(pid) = fs::read_to_string(&pid_file).ok().and_then(|raw| parse_pid(&raw)) else {
        return;
    };
    if process_alive(pid) {
        terminate_pid(pid);
    }
    let _ = fs::remove_file(pid_file);
}

/// Why the collector is not serving.
#[derive(Clone, Debug, PartialEq)]
pub enum StartError {
    /// Something else already answers `/health` on the preferred port.
    PortHeld(u16),
    Failed(String),
}

pub struct Collector {
    child: Child,
    pub port: u16,
    pub version: String,
}

pub struct Bundle {
    pub binary: PathBuf,
    pub static_dir: PathBuf,
}

impl Collector {
    /// Resolve a port, spawn the bundled binary and wait for `/health`.
    pub fn start(home: &CotHome, bundle: &Bundle) -> Result<Collector, StartError> {
        reap_orphan(home);

        let preferred = home.preferred_port(std::env::var("COT_PORT").ok().as_deref());
        if health(preferred).is_some() {
            return Err(StartError::PortHeld(preferred));
        }
        if !bundle.binary.is_file() {
            return Err(StartError::Failed(format!(
                "Bundled collector missing at {}",
                bundle.binary.display()
            )));
        }
        let port = first_free_port(preferred, is_port_free)
            .ok_or_else(|| StartError::Failed(format!("No free port near {preferred}")))?;

        let mut child = spawn(home, bundle, port)
            .map_err(|e| StartError::Failed(format!("Could not start the collector: {e}")))?;
        let _ = fs::write(home.pid_file(), child.id().to_string());

        let log = home.log_file();
        let deadline = Instant::now() + STARTUP_TIMEOUT;
        while Instant::now() < deadline {
            if let Ok(Some(status)) = child.try_wait() {
                let _ = fs::remove_file(home.pid_file());
                return Err(StartError::Failed(format!(
                    "Collector exited on startup ({status}). See {}",
                    log.display()
                )));
            }
            if let Some(version) = health(port) {
                if let Err(e) = home.save_endpoint(port) {
                    eprintln!("cot: could not write {}: {e}", home.config_file().display());
                }
                return Ok(Collector { child, port, version });
            }
            std::thread::sleep(Duration::from_millis(250));
        }

        let mut collector = Collector { child, port, version: String::new() };
        collector.stop(home);
        Err(StartError::Failed(format!(
            "Collector did not become healthy. See {}",
            log.display()
        )))
    }

    /// True once the process has exited on its own.
    pub fn has_exited(&mut self) -> bool {
        !matches!(self.child.try_wait(), Ok(None))
    }

    pub fn stop(&mut self, home: &CotHome) {
        if !self.has_exited() {
            terminate_pid(self.child.id() as i32);
            let _ = self.child.wait();
        }
        let _ = fs::remove_file(home.pid_file());
    }
}

fn spawn(home: &CotHome, bundle: &Bundle, port: u16) -> std::io::Result<Child> {
    let log_path = home.log_file();
    if let Some(dir) = log_path.parent() {
        fs::create_dir_all(dir)?;
    }
    let log = OpenOptions::new().create(true).append(true).open(&log_path)?;

    Command::new(&bundle.binary)
        .env("COT_HOST", "127.0.0.1")
        .env("COT_PORT", port.to_string())
        .env("COT_DB_PATH", home.database_file())
        .env("COT_STATIC_DIR", &bundle.static_dir)
        // The collector exits on its own if this app dies without cleaning up.
        .env("COT_PARENT_PID", std::process::id().to_string())
        // The app's updater replaces the dashboard's update banner.
        .env("COT_DISABLE_UPDATE_CHECK", "1")
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .spawn()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home(name: &str) -> CotHome {
        let dir = std::env::temp_dir().join(format!("cot-desktop-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        CotHome(dir)
    }

    #[test]
    fn port_comes_from_config_endpoint() {
        assert_eq!(port_from_config(r#"{"endpoint": "http://127.0.0.1:31340"}"#), Some(31340));
        assert_eq!(port_from_config(r#"{"endpoint": "http://localhost:4000/"}"#), Some(4000));
        assert_eq!(port_from_config(r#"{"endpoint": "http://127.0.0.1"}"#), None);
        assert_eq!(port_from_config(r#"{"other": 1}"#), None);
        assert_eq!(port_from_config("not json"), None);
    }

    #[test]
    fn env_port_beats_config_beats_default() {
        let home = temp_home("port");
        assert_eq!(home.preferred_port(None), DEFAULT_PORT);

        home.save_endpoint(31345).unwrap();
        assert_eq!(home.preferred_port(None), 31345);
        assert_eq!(home.preferred_port(Some("31399")), 31399);
        assert_eq!(home.preferred_port(Some("garbage")), 31345);
        let _ = fs::remove_dir_all(home.dir());
    }

    #[test]
    fn first_free_port_skips_taken_ports() {
        let taken = [31337, 31338];
        assert_eq!(first_free_port(31337, |p| !taken.contains(&p)), Some(31339));
        assert_eq!(first_free_port(31337, |_| true), Some(31337));
        assert_eq!(first_free_port(31337, |_| false), None);
        // Never wraps past u16::MAX.
        assert_eq!(first_free_port(u16::MAX, |p| p != u16::MAX), None);
    }

    #[test]
    fn real_port_probe_sees_a_bound_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(!is_port_free(port));
        drop(listener);
        assert!(is_port_free(port));
    }

    #[test]
    fn pid_file_parsing() {
        assert_eq!(parse_pid("4242\n"), Some(4242));
        assert_eq!(parse_pid("  17 "), Some(17));
        assert_eq!(parse_pid("0"), None);
        assert_eq!(parse_pid("-5"), None);
        assert_eq!(parse_pid(""), None);
        assert_eq!(parse_pid("abc"), None);
    }

    #[test]
    fn health_response_parsing() {
        let ok = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"status\":\"ok\",\"version\":\"1.9.0\"}";
        assert_eq!(parse_health_response(ok), Some("1.9.0".into()));
        let no_version = "HTTP/1.1 200 OK\r\n\r\n{\"status\":\"ok\"}";
        assert_eq!(parse_health_response(no_version), Some("unknown".into()));
        let not_found = "HTTP/1.1 404 Not Found\r\n\r\n{\"detail\":\"Not Found\"}";
        assert_eq!(parse_health_response(not_found), None);
        let degraded = "HTTP/1.1 200 OK\r\n\r\n{\"status\":\"degraded\"}";
        assert_eq!(parse_health_response(degraded), None);
        assert_eq!(parse_health_response("garbage"), None);
    }
}
