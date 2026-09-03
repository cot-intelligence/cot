import SwiftUI

@main
struct CotApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var collector = CollectorController()
    @State private var reloadToken = 0

    var body: some Scene {
        Window("cot", id: "dashboard") {
            DashboardScene(collector: collector, reloadToken: reloadToken)
                .task {
                    appDelegate.collector = collector
                    await collector.start()
                }
        }
        .defaultSize(width: 1280, height: 860)
        .commands {
            CommandGroup(after: .toolbar) {
                Button("Reload Dashboard") { reloadToken += 1 }
                    .keyboardShortcut("r", modifiers: .command)
            }
            CommandGroup(replacing: .newItem) {}
        }

        MenuBarExtra {
            MenuBarView(collector: collector, reloadToken: $reloadToken)
        } label: {
            Image(systemName: collector.state.isLive ? "circle.fill" : "circle")
                .accessibilityLabel(collector.state.summary)
        }
    }
}

private struct DashboardScene: View {
    @ObservedObject var collector: CollectorController
    let reloadToken: Int

    var body: some View {
        Group {
            if let url = collector.dashboardURL {
                DashboardWebView(url: url, reloadToken: reloadToken)
            } else {
                CollectorStatusView(state: collector.state) {
                    Task { await collector.restart() }
                }
            }
        }
        .frame(minWidth: 900, minHeight: 600)
    }
}

/// The collector has to outlive the window — closing the dashboard should leave
/// traces being collected — but must not outlive the app.
final class AppDelegate: NSObject, NSApplicationDelegate {
    @MainActor var collector: CollectorController?
    private var signalSources: [DispatchSourceSignal] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        installSignalHandlers()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationWillTerminate(_ notification: Notification) {
        MainActor.assumeIsolated { collector?.stop() }
    }

    /// `applicationWillTerminate` never fires for a plain SIGTERM (a `pkill`, or
    /// a logout that runs out of patience), which would leave the collector
    /// running. Catch the signal and shut it down first.
    private func installSignalHandlers() {
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler {
                MainActor.assumeIsolated { self.collector?.stop() }
                exit(0)
            }
            source.resume()
            signalSources.append(source)
        }
    }
}
