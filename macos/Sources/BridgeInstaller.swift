import Foundation

/// Wires agent hooks by running the same `install.sh` the curl path uses, served
/// by the collector we just started. Interactive prompts need a terminal, so it
/// runs in Terminal.app rather than a headless Process.
enum BridgeInstaller {
    static func openInstaller(port: Int) {
        let command = "COT_ENDPOINT=http://127.0.0.1:\(port) "
            + "curl -fsSL http://127.0.0.1:\(port)/install.sh | sh"
        runInTerminal(command)
    }

    static func openRepair(port: Int) {
        let command = "COT_ENDPOINT=http://127.0.0.1:\(port) "
            + "curl -fsSL http://127.0.0.1:\(port)/install.sh | sh -s -- --repair"
        runInTerminal(command)
    }

    private static func runInTerminal(_ command: String) {
        let escaped = command.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        let script = """
        tell application "Terminal"
            activate
            do script "\(escaped)"
        end tell
        """
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        task.arguments = ["-e", script]
        try? task.run()
    }
}
