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

        // Reports the page's theme and clears room for the traffic lights in the
        // shell header — see `Coordinator.chromeBridge`.
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: Coordinator.themeChannel)
        controller.addUserScript(
            WKUserScript(source: Coordinator.chromeBridge, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
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

        /// Two jobs, both about making the window chromeless rather than
        /// changing the dashboard: report the page's theme so the window
        /// appearance can follow it, and clear a landing strip for the traffic
        /// lights in the app shell's own header.
        ///
        /// The shell header's 32px content box is pinned below `topPadding` so
        /// the row is not flush against the window edge, and the titlebar is
        /// grown to match (see `HeaderMetrics`) so the traffic lights land on
        /// that same row. The left pad clears the lights themselves. Only the
        /// shell header is touched: the app has other <header> elements nested
        /// inside pages.
        static let chromeBridge = """
        (function () {
          var CHROME_CLASS = 'cot-native-chrome';

          var style = document.createElement('style');
          style.textContent =
            '.' + CHROME_CLASS + '{padding-top:\(Int(HeaderMetrics.topPadding))px!important;' +
            'padding-left:\(Int(HeaderMetrics.contentLeading))px!important}';
          document.head.appendChild(style);

          var markShellHeader = function () {
            var headers = document.querySelectorAll('header');
            var shell = null;
            for (var i = 0; i < headers.length; i++) {
              var box = headers[i].getBoundingClientRect();
              var spansWindow = box.width > window.innerWidth * 0.8;
              // Already shifted, or sitting at the top edge and full width.
              if (spansWindow && (box.top <= \(Int(HeaderMetrics.topPadding)) || headers[i].classList.contains(CHROME_CLASS))) {
                shell = headers[i];
                break;
              }
            }
            for (var j = 0; j < headers.length; j++) {
              headers[j].classList.toggle(CHROME_CLASS, headers[j] === shell);
            }
          };

          var sendTheme = function () {
            window.webkit.messageHandlers.\(themeChannel).postMessage(
              document.documentElement.getAttribute('data-theme') || 'light'
            );
          };

          new MutationObserver(sendTheme).observe(document.documentElement, {
            attributes: true, attributeFilter: ['data-theme']
          });
          // Routes swap the shell header out, so re-mark on any body change.
          new MutationObserver(markShellHeader).observe(document.body, {
            childList: true, subtree: true
          });
          window.addEventListener('hashchange', markShellHeader);

          markShellHeader();
          sendTheme();
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
