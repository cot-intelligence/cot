import SwiftUI
import WebKit

/// Hosts the existing React dashboard. Nothing about the frontend changes — the
/// app is a native window around the same pages the browser gets.
struct DashboardWebView: NSViewRepresentable {
    let url: URL
    /// Bumping this forces a reload, e.g. after the collector restarts on a new port.
    let reloadToken: Int
    /// The page's theme, reported back so the native titlebar can match it.
    let onThemeChange: (DashboardTheme) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onThemeChange: onThemeChange) }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()

        // The dashboard keeps its theme in localStorage and on `data-theme`, not
        // in the system appearance, so the titlebar has to hear it from the page.
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: Coordinator.themeChannel)
        controller.addUserScript(
            WKUserScript(source: Coordinator.themeBridge, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        )
        configuration.userContentController = controller

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

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        static let themeChannel = "cotTheme"
        static let themeBridge = """
        (function () {
          var send = function () {
            var theme = document.documentElement.getAttribute('data-theme') || 'light';
            window.webkit.messageHandlers.\(themeChannel).postMessage(theme);
          };
          new MutationObserver(send).observe(document.documentElement, {
            attributes: true, attributeFilter: ['data-theme']
          });
          send();
        })();
        """

        var loadedURL: URL?
        var loadedToken = -1
        private let onThemeChange: (DashboardTheme) -> Void

        init(onThemeChange: @escaping (DashboardTheme) -> Void) {
            self.onThemeChange = onThemeChange
        }

        func userContentController(
            _ controller: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard message.name == Self.themeChannel,
                  let raw = message.body as? String,
                  let theme = DashboardTheme(rawValue: raw)
            else { return }
            onThemeChange(theme)
        }

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
    let theme: DashboardTheme
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
                    .foregroundStyle(theme.foreground)
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
                    .foregroundStyle(theme.foreground)
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
                    .foregroundStyle(theme.foreground)
                Button("Start collector", action: onRetry)
            }
        }
        .frame(maxWidth: 420)
        .padding(40)
    }
}
