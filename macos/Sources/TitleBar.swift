import SwiftUI

/// Brand palette from _DESIGN_LANGUAGE.md. The dashboard owns its own theme
/// (localStorage, not system appearance), so the titlebar takes its cue from
/// the page rather than from `colorScheme`.
enum Brand {
    static let ink = Color(red: 0x11 / 255, green: 0x11 / 255, blue: 0x11 / 255)
    static let cream = Color(red: 0xF4 / 255, green: 0xF0 / 255, blue: 0xEA / 255)
    static let creamDark = Color(red: 0xE8 / 255, green: 0xE4 / 255, blue: 0xDE / 255)
    static let vermilion = Color(red: 1, green: 0x45 / 255, blue: 0)
    static let cobalt = Color(red: 0x2B / 255, green: 0x5C / 255, blue: 0xE6 / 255)
    static let olive = Color(red: 0x3A / 255, green: 0x4D / 255, blue: 0x39 / 255)
    /// Olive is near-black against ink; lift it so "live" reads in dark mode.
    static let oliveLifted = Color(red: 0x7C / 255, green: 0x9A / 255, blue: 0x6B / 255)
}

enum DashboardTheme: String {
    case light
    case dark

    static let inkRaised = Color(red: 0x1A / 255, green: 0x1A / 255, blue: 0x1A / 255)

    var background: Color { self == .dark ? Brand.ink : Brand.cream }
    /// A half-step off the page ground — `cream-dark` is the design language's
    /// own "section alternate", and ink gets the same treatment upward.
    var barBackground: Color { self == .dark ? Self.inkRaised : Brand.creamDark }
    var foreground: Color { self == .dark ? Brand.cream : Brand.ink }
    var success: Color { self == .dark ? Brand.oliveLifted : Brand.olive }

    var appearance: NSAppearance? {
        NSAppearance(named: self == .dark ? .darkAqua : .aqua)
    }
}

/// The window's own titlebar, replaced. Height matches the dashboard's header
/// so the two read as one bar; the leading inset clears the traffic lights.
struct TitleBarView: View {
    @ObservedObject var collector: CollectorController
    let theme: DashboardTheme

    private var statusColor: Color {
        switch collector.state {
        case .running, .attached: return theme.success
        case .starting: return Brand.cobalt
        case .apiOnly, .failed: return Brand.vermilion
        case .stopped: return theme.foreground.opacity(0.35)
        }
    }

    private var statusLabel: String {
        switch collector.state {
        case let .running(port, _): return "collecting · \(String(port))"
        case let .attached(port, _): return "attached · \(String(port))"
        case .starting: return "starting"
        case let .apiOnly(port, _): return "api only · \(String(port))"
        case .stopped: return "stopped"
        case .failed: return "failed"
        }
    }

    var body: some View {
        ZStack {
            WindowDragArea()

            HStack(spacing: 10) {
                AppIconMark()
                    .frame(width: 20, height: 20)

                StatusPill(color: statusColor, label: statusLabel, theme: theme)

                Spacer(minLength: 0)
            }
            .padding(.leading, 78)
            .padding(.trailing, 16)
        }
        .frame(height: 42)
        .background(theme.barBackground)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(theme.foreground.opacity(0.12))
                .frame(height: 1)
        }
    }
}

/// The app's own icon, read from the bundle — one source of truth with the Dock
/// and the Finder, so a redesigned icns lands here too.
private struct AppIconMark: View {
    var body: some View {
        if let icon = NSApp.applicationIconImage {
            Image(nsImage: icon)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
        } else {
            RoundedRectangle(cornerRadius: 4)
                .fill(Brand.ink)
                .overlay(
                    Text("c")
                        .font(.system(size: 11, weight: .bold, design: .serif))
                        .italic()
                        .foregroundStyle(Brand.vermilion)
                )
        }
    }
}

private struct StatusPill: View {
    let color: Color
    let label: String
    let theme: DashboardTheme

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)

            Text(label)
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .tracking(1.1)
                .textCase(.uppercase)
                .foregroundStyle(theme.foreground.opacity(0.6))
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        .overlay(
            Rectangle()
                .stroke(theme.foreground.opacity(0.12), lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Collector \(label)")
    }
}

/// Restores click-drag and double-click-to-zoom, which a `fullSizeContentView`
/// window loses along with its titlebar.
private struct WindowDragArea: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { DragView() }
    func updateNSView(_ nsView: NSView, context: Context) {}

    private final class DragView: NSView {
        override func mouseDown(with event: NSEvent) {
            if event.clickCount == 2 {
                window?.performZoom(nil)
            } else {
                window?.performDrag(with: event)
            }
        }
    }
}

/// Strips the stock titlebar and keeps the window's appearance in step with the
/// dashboard's theme, so the traffic lights and resize chrome match the page.
struct WindowChrome: NSViewRepresentable {
    let theme: DashboardTheme

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: .zero)
        // The window isn't attached yet at make time; apply on the next pass.
        DispatchQueue.main.async { apply(to: view.window, context.coordinator) }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        apply(to: nsView.window, context.coordinator)
    }

    /// Writing `appearance` or `backgroundColor` invalidates the view hierarchy,
    /// which calls back into `updateNSView` — so only write on an actual change.
    private func apply(to window: NSWindow?, _ coordinator: Coordinator) {
        guard let window else { return }

        if !coordinator.didConfigureChrome {
            coordinator.didConfigureChrome = true
            window.styleMask.insert(.fullSizeContentView)
            window.titlebarAppearsTransparent = true
            window.titleVisibility = .hidden
            window.titlebarSeparatorStyle = .none
            window.isMovableByWindowBackground = false
        }

        guard coordinator.appliedTheme != theme else { return }
        coordinator.appliedTheme = theme
        window.backgroundColor = NSColor(theme.background)
        window.appearance = theme.appearance
    }

    final class Coordinator {
        var didConfigureChrome = false
        var appliedTheme: DashboardTheme?
    }
}
