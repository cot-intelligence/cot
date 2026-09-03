import SwiftUI

struct MenuBarView: View {
    @ObservedObject var collector: CollectorController
    @Binding var reloadToken: Int
    @Environment(\.openWindow) private var openWindow
    @State private var launchAtLogin = LoginItem.isEnabled

    var body: some View {
        Text(collector.state.summary)

        Divider()

        Button("Open Dashboard") {
            openWindow(id: "dashboard")
            NSApp.activate(ignoringOtherApps: true)
        }
        .disabled(!collector.state.isLive)

        Button("Copy Endpoint") {
            guard let port = collector.state.port else { return }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(
                CollectorEndpoint.url(port: port).absoluteString, forType: .string
            )
        }
        .disabled(!collector.state.isServing)

        Divider()

        if collector.state.isServing {
            Button("Stop Collector") { collector.stop() }
            Button("Restart Collector") { Task { await collector.restart() } }
        } else {
            Button("Start Collector") { Task { await collector.start() } }
        }

        Divider()

        Button("Install Agent Hooks…") {
            if let port = collector.state.port { BridgeInstaller.openInstaller(port: port) }
        }
        .disabled(!collector.state.isServing)

        Button("Repair Agent Hooks…") {
            if let port = collector.state.port { BridgeInstaller.openRepair(port: port) }
        }
        .disabled(!collector.state.isServing)

        Button("Reveal Data Folder") {
            NSWorkspace.shared.selectFile(
                CollectorEndpoint.databaseFile.path,
                inFileViewerRootedAtPath: CollectorEndpoint.cotHome.path
            )
        }

        Button("Open Collector Log") {
            NSWorkspace.shared.open(CollectorEndpoint.logFile)
        }

        Toggle("Start cot at Login", isOn: $launchAtLogin)
            .onChange(of: launchAtLogin) { _, newValue in
                if !LoginItem.setEnabled(newValue) {
                    launchAtLogin = LoginItem.isEnabled
                }
            }

        Divider()

        Button("Quit cot") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }
}
