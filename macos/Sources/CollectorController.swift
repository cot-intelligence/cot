import Combine
import Foundation

enum CollectorState: Equatable {
    /// Nothing running and nothing to attach to.
    case stopped
    /// Spawning the bundled binary and waiting for `/health`.
    case starting
    /// The collector we spawned is serving.
    case running(port: Int, health: CollectorHealth)
    /// Someone else's collector (the Docker install, or `cot up`) already owns
    /// the port. We render it instead of fighting over the database.
    case attached(port: Int, health: CollectorHealth)
    /// An API-only collector holds the port — `docker compose up` in dev, where
    /// Vite serves the frontend. There is no dashboard to render, and taking the
    /// port would give us two writers on one SQLite file.
    case apiOnly(port: Int, health: CollectorHealth)
    case failed(String)

    var port: Int? {
        switch self {
        case let .running(port, _), let .attached(port, _): return port
        case let .apiOnly(port, _): return port
        case .stopped, .starting, .failed: return nil
        }
    }

    /// Live *and* renderable. `apiOnly` is live but has no dashboard to show.
    var isLive: Bool {
        switch self {
        case .running, .attached: return true
        case .stopped, .starting, .apiOnly, .failed: return false
        }
    }

    /// Serving requests, whether or not it can render.
    var isServing: Bool { port != nil }

    var summary: String {
        switch self {
        case .stopped: return "Collector stopped"
        case .starting: return "Starting collector…"
        case let .running(port, health): return "Running on \(port) · v\(health.version)"
        case let .attached(port, health): return "Attached to \(port) · v\(health.version)"
        case let .apiOnly(port, _): return "API-only collector on \(port)"
        case let .failed(message): return "Failed — \(message)"
        }
    }
}

/// Owns the lifetime of the collector process for the app: spawns the frozen
/// binary from `Contents/Resources`, keeps `~/.cot/config.json` pointed at it,
/// and tears it down on quit.
@MainActor
final class CollectorController: ObservableObject {
    @Published private(set) var state: CollectorState = .stopped

    private var process: Process?
    private var healthTimer: Timer?

    /// The frozen collector, laid down by macos/build.sh.
    private var bundledBinary: URL? {
        guard let resources = Bundle.main.resourceURL else { return nil }
        let candidate = resources
            .appendingPathComponent("cot-collector", isDirectory: true)
            .appendingPathComponent("cot-collector")
        return FileManager.default.isExecutableFile(atPath: candidate.path) ? candidate : nil
    }

    /// Dashboard built by `npm run build` and copied into the bundle.
    private var bundledStatic: URL? {
        guard let resources = Bundle.main.resourceURL else { return nil }
        let candidate = resources.appendingPathComponent("static", isDirectory: true)
        var isDirectory: ObjCBool = false
        FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDirectory)
        return isDirectory.boolValue ? candidate : nil
    }

    var dashboardURL: URL? {
        guard state.isLive, let port = state.port else { return nil }
        return CollectorEndpoint.url(port: port)
    }

    // MARK: - Lifecycle

    func start() async {
        guard !state.isServing, process == nil else { return }
        state = .starting

        reapOrphanedCollector()

        let preferred = CollectorEndpoint.savedPort() ?? CollectorEndpoint.defaultPort

        // A collector may already be up — the Docker install, or a second copy of
        // this app. Two writers on one SQLite file is the one thing worth
        // avoiding, so attach rather than spawn.
        if let health = await CollectorEndpoint.health(port: preferred) {
            state = await CollectorEndpoint.servesDashboard(port: preferred)
                ? .attached(port: preferred, health: health)
                : .apiOnly(port: preferred, health: health)
            beginHealthMonitoring()
            return
        }

        guard let binary = bundledBinary else {
            state = .failed("Bundled collector missing — run macos/build.sh")
            return
        }
        guard let port = CollectorEndpoint.firstFreePort(from: preferred) else {
            state = .failed("No free port near \(preferred)")
            return
        }

        do {
            try spawn(binary: binary, port: port)
        } catch {
            state = .failed(error.localizedDescription)
            return
        }

        // uvicorn binds in well under a second cold; the frozen binary unpacks
        // first, so allow a generous window before calling it a failure.
        for _ in 0..<60 {
            if process?.isRunning != true {
                state = .failed("Collector exited on startup — see \(CollectorEndpoint.logFile.path)")
                return
            }
            if let health = await CollectorEndpoint.health(port: port) {
                try? CollectorEndpoint.saveEndpoint(port: port)
                state = .running(port: port, health: health)
                beginHealthMonitoring()
                return
            }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }

        stop()
        state = .failed("Collector did not become healthy — see \(CollectorEndpoint.logFile.path)")
    }

    func stop() {
        healthTimer?.invalidate()
        healthTimer = nil

        if let process, process.isRunning {
            process.terminate()
            // Give uvicorn a moment to close the SQLite connection cleanly.
            let deadline = Date().addingTimeInterval(5)
            while process.isRunning && Date() < deadline {
                usleep(100_000)
            }
            if process.isRunning {
                kill(process.processIdentifier, SIGKILL)
            }
        }
        process = nil
        try? FileManager.default.removeItem(at: CollectorEndpoint.pidFile)
        state = .stopped
    }

    func restart() async {
        stop()
        await start()
    }

    // MARK: - Internals

    private func spawn(binary: URL, port: Int) throws {
        let fileManager = FileManager.default
        try fileManager.createDirectory(
            at: CollectorEndpoint.logFile.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        if !fileManager.fileExists(atPath: CollectorEndpoint.logFile.path) {
            fileManager.createFile(atPath: CollectorEndpoint.logFile.path, contents: nil)
        }
        let log = try FileHandle(forWritingTo: CollectorEndpoint.logFile)
        log.seekToEndOfFile()

        var environment = ProcessInfo.processInfo.environment
        environment["COT_HOST"] = "127.0.0.1"
        environment["COT_PORT"] = String(port)
        environment["COT_DB_PATH"] = CollectorEndpoint.databaseFile.path
        environment["PYTHONUNBUFFERED"] = "1"
        // The collector exits on its own if this app dies without cleaning up.
        environment["COT_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        if let staticDir = bundledStatic {
            environment["COT_STATIC_DIR"] = staticDir.path
        }

        let task = Process()
        task.executableURL = binary
        task.environment = environment
        task.standardOutput = log
        task.standardError = log
        task.terminationHandler = { [weak self] _ in
            Task { @MainActor in self?.handleUnexpectedExit() }
        }
        try task.run()
        process = task
        try? String(task.processIdentifier).write(
            to: CollectorEndpoint.pidFile, atomically: true, encoding: .utf8
        )
    }

    /// A collector we spawned that outlived its app — force quit, crash, or a
    /// SIGKILL. Two uvicorn processes on one SQLite file is worth preventing, so
    /// take the previous one down before claiming the port.
    private func reapOrphanedCollector() {
        guard let raw = try? String(contentsOf: CollectorEndpoint.pidFile, encoding: .utf8),
              let pid = Int32(raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              pid > 0
        else { return }

        defer { try? FileManager.default.removeItem(at: CollectorEndpoint.pidFile) }

        // kill(pid, 0) only probes; ESRCH means the process is already gone.
        guard kill(pid, 0) == 0 else { return }
        kill(pid, SIGTERM)

        let deadline = Date().addingTimeInterval(5)
        while kill(pid, 0) == 0 && Date() < deadline {
            usleep(100_000)
        }
        if kill(pid, 0) == 0 {
            kill(pid, SIGKILL)
        }
    }

    private func handleUnexpectedExit() {
        guard case .running = state else { return }
        state = .failed("Collector exited — see \(CollectorEndpoint.logFile.path)")
        process = nil
    }

    /// Cheap liveness poll so the menu bar reflects an externally stopped
    /// collector (e.g. `cot down` against an attached container).
    private func beginHealthMonitoring() {
        healthTimer?.invalidate()
        healthTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.refreshHealth() }
        }
    }

    private func refreshHealth() async {
        guard let port = state.port else { return }
        let health = await CollectorEndpoint.health(port: port)

        switch (state, health) {
        case let (.running, .some(health)):
            state = .running(port: port, health: health)
        case let (.attached, .some(health)):
            state = .attached(port: port, health: health)
        case let (.apiOnly, .some(health)):
            state = await CollectorEndpoint.servesDashboard(port: port)
                ? .attached(port: port, health: health)
                : .apiOnly(port: port, health: health)
        case (.attached, .none), (.apiOnly, .none):
            // The container we were borrowing went away; take over the port.
            state = .stopped
            await start()
        case (.running, .none):
            break // terminationHandler reports the real failure.
        default:
            break
        }
    }
}
