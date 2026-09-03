import SwiftUI
import WebKit

/// Hosts the existing React dashboard. Nothing about the frontend changes — the
/// app is a native window around the same pages the browser gets.
struct DashboardWebView: NSViewRepresentable {
    let url: URL
    /// Bumping this forces a reload, e.g. after the collector restarts on a new port.
    let reloadToken: Int

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.setValue(false, forKey: "drawsBackground")
        webView.load(URLRequest(url: url))
        context.coordinator.loadedURL = url
        context.coordinator.loadedToken = reloadToken
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        guard context.coordinator.loadedURL != url || context.coordinator.loadedToken != reloadToken
        else { return }
        context.coordinator.loadedURL = url
        context.coordinator.loadedToken = reloadToken
        webView.load(URLRequest(url: url))
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var loadedURL: URL?
        var loadedToken = -1

        /// Keep the app on the local collector; anything else (docs, GitHub)
        /// opens in the user's browser.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let target = navigationAction.request.url else {
                decisionHandler(.allow)
                return
            }
            let isLocal = target.host == "127.0.0.1" || target.host == "localhost"
            if isLocal || target.scheme == "about" || target.scheme == "blob" || target.scheme == "data" {
                decisionHandler(.allow)
            } else {
                decisionHandler(.cancel)
                NSWorkspace.shared.open(target)
            }
        }
    }
}

/// Shown while the collector is starting, or when it could not start at all.
struct CollectorStatusView: View {
    let state: CollectorState
    let onRetry: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            switch state {
            case .starting:
                ProgressView()
                Text("Starting the collector…")
                    .foregroundStyle(.secondary)
            case let .apiOnly(port, health):
                Image(systemName: "square.stack.3d.up.slash")
                    .font(.system(size: 28))
                    .foregroundStyle(.secondary)
                // String(port) — plain Int interpolation renders "31,337".
                Text("A dev collector is using port \(String(port))")
                    .font(.headline)
                Text(
                    "cot v\(health.version) is serving the API there but not the dashboard — "
                    + "that's what `docker compose up` does, with Vite rendering the frontend "
                    + "separately. Stop it (`docker rm -f cot-api`) and retry to use the app's "
                    + "own collector."
                )
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                HStack {
                    Button("Open Vite dev server") {
                        NSWorkspace.shared.open(URL(string: "http://localhost:4000")!)
                    }
                    Button("Retry", action: onRetry)
                }
            case let .failed(message):
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 28))
                    .foregroundStyle(.orange)
                Text("The collector could not start")
                    .font(.headline)
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .textSelection(.enabled)
                Button("Try again", action: onRetry)
            default:
                Image(systemName: "moon.zzz")
                    .font(.system(size: 28))
                    .foregroundStyle(.secondary)
                Text("Collector stopped")
                    .font(.headline)
                Button("Start collector", action: onRetry)
            }
        }
        .frame(maxWidth: 420)
        .padding(40)
    }
}
