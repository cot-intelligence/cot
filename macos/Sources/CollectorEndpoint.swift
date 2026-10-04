import Darwin
import Foundation

/// Everything about *where* the collector lives: the `~/.cot` home the Docker
/// install already uses, the endpoint the bridge reads, and free-port probing.
enum CollectorEndpoint {
    static let defaultPort = 31337

    static var cotHome: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".cot", isDirectory: true)
    }

    static var configFile: URL { cotHome.appendingPathComponent("config.json") }
    static var databaseFile: URL { cotHome.appendingPathComponent("cot.db") }
    static var logFile: URL { cotHome.appendingPathComponent("logs/collector.log") }
    /// PID of the collector this app spawned, so a crashed or force-quit app
    /// doesn't leave one running against the database.
    static var pidFile: URL { cotHome.appendingPathComponent("app-collector.pid") }

    static func url(port: Int) -> URL {
        URL(string: "http://127.0.0.1:\(port)")!
    }

    /// Port recorded by a previous install, so the app keeps serving hooks that
    /// were wired to a non-default port. `COT_PORT` overrides it for testing.
    static func savedPort() -> Int? {
        if let override = ProcessInfo.processInfo.environment["COT_PORT"], let port = Int(override) {
            return port
        }
        guard let data = try? Data(contentsOf: configFile),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let endpoint = json["endpoint"] as? String,
              let port = URLComponents(string: endpoint)?.port
        else { return nil }
        return port
    }

    /// Point the bridge at whatever port we ended up on. Hooks read this file on
    /// every event, so writing it is what makes a non-default port work.
    static func saveEndpoint(port: Int) throws {
        try FileManager.default.createDirectory(at: cotHome, withIntermediateDirectories: true)
        let body = "{\"endpoint\": \"http://127.0.0.1:\(port)\"}\n"
        try body.write(to: configFile, atomically: true, encoding: .utf8)
    }

    /// True when nothing holds the port on the loopback interface.
    static func isPortFree(_ port: Int) -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }

        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = UInt16(port).bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")

        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        return bound == 0
    }

    /// First free port at or after `start`, matching the installer's behaviour.
    static func firstFreePort(from start: Int, attempts: Int = 32) -> Int? {
        for port in start..<(start + attempts) where isPortFree(port) {
            return port
        }
        return nil
    }

    /// `/health` from a collector already listening on `port`, or nil.
    static func health(port: Int, timeout: TimeInterval = 1.5) async -> CollectorHealth? {
        var request = URLRequest(url: url(port: port).appendingPathComponent("health"))
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData

        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["status"] as? String == "ok"
        else { return nil }

        return CollectorHealth(
            version: json["version"] as? String ?? "unknown",
            databasePath: json["db_path"] as? String ?? databaseFile.path
        )
    }
    /// Whether this collector also serves the dashboard. The production image
    /// and the frozen binary both do; a bare `docker compose` API container
    /// does not, and rendering that in the window just shows JSON.
    static func servesDashboard(port: Int, timeout: TimeInterval = 2) async -> Bool {
        var request = URLRequest(url: url(port: port))
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData

        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, http.statusCode == 200
        else { return false }

        let contentType = http.value(forHTTPHeaderField: "Content-Type") ?? ""
        return contentType.contains("text/html")
    }
}

struct CollectorHealth: Equatable {
    let version: String
    let databasePath: String
}
