import SwiftUI

/// Brand palette from _DESIGN_LANGUAGE.md.
enum Brand {
    static let ink = Color(red: 0x11 / 255, green: 0x11 / 255, blue: 0x11 / 255)
    static let cream = Color(red: 0xF4 / 255, green: 0xF0 / 255, blue: 0xEA / 255)
}

/// The dashboard owns its theme (localStorage, not system appearance), so the
/// window has to hear about it from the page rather than read `colorScheme`.
enum DashboardTheme: String {
    case light
    case dark

    var background: Color { self == .dark ? Brand.ink : Brand.cream }
    var foreground: Color { self == .dark ? Brand.cream : Brand.ink }

    var appearance: NSAppearance? {
        NSAppearance(named: self == .dark ? .darkAqua : .aqua)
    }
}

/// Geometry shared by the window chrome and the injected page CSS: the header
/// row the dashboard draws, and where the traffic lights have to sit to land on
/// it. A standard titlebar centres its buttons at y=16, which would force the
/// header flush against the top edge — so the titlebar is grown instead and the
/// buttons re-centred in it, leaving the row real breathing room.
enum HeaderMetrics {
    /// Height of the shell header's content box (a 32px control row).
    static let rowHeight: CGFloat = 32
    /// Breathing room above that row.
    static let topPadding: CGFloat = 14
    /// Where the row's centre lands, and so where the traffic lights must.
    static var rowCenterY: CGFloat { topPadding + rowHeight / 2 }
    /// Titlebar tall enough to hold the buttons at that centre.
    static var titlebarHeight: CGFloat { rowCenterY * 2 }
    /// Left edge of the page content, clear of the buttons.
    static let contentLeading: CGFloat = 92
}

/// A chromeless window passes every event in the titlebar band straight through
/// to the web view, so there is nothing left to drag the window by. This puts a
/// real handle back in the empty middle of the shell header — clear of the
/// wordmark on the left and the header controls on the right, which stay
/// clickable because nothing covers them.
///
/// It is installed into the window's frame view — the traffic lights' own
/// superview — rather than anywhere inside the SwiftUI hierarchy. Both a
/// representable in an `.overlay` and a subview of the content view draw in the
/// right place but never receive the mouse: the hosting view hit-tests the
/// SwiftUI tree, finds nothing interactive, and hands the event to the web view.
private final class WindowDragHandle: NSView {
    static let leadingClearance: CGFloat = 150
    static let trailingClearance: CGFloat = 300

    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            window?.performZoom(nil)
        } else {
            window?.performDrag(with: event)
        }
    }

    static func install(in window: NSWindow) {
        guard let frameView = window.contentView?.superview,
              !frameView.subviews.contains(where: { $0 is WindowDragHandle })
        else { return }

        let handle = WindowDragHandle(frame: .zero)
        handle.translatesAutoresizingMaskIntoConstraints = false
        frameView.addSubview(handle, positioned: .above, relativeTo: nil)

        NSLayoutConstraint.activate([
            handle.topAnchor.constraint(equalTo: frameView.topAnchor),
            handle.heightAnchor.constraint(
                equalToConstant: HeaderMetrics.rowCenterY + HeaderMetrics.rowHeight / 2
            ),
            handle.leadingAnchor.constraint(equalTo: frameView.leadingAnchor, constant: leadingClearance),
            handle.trailingAnchor.constraint(equalTo: frameView.trailingAnchor, constant: -trailingClearance),
        ])
    }
}

/// There is no titlebar view: the window is chromeless and the dashboard renders
/// edge to edge beneath the traffic lights, which the page's own header row is
/// shifted to sit alongside. This keeps the window's appearance in step with the
/// page so the traffic lights and resize chrome match it.
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
            growTitlebar(window)
            WindowDragHandle.install(in: window)
            coordinator.keepTrafficLightsCentered(on: window)
        }

        centerTrafficLights(in: window)

        guard coordinator.appliedTheme != theme else { return }
        coordinator.appliedTheme = theme
        window.backgroundColor = NSColor(theme.background)
        window.appearance = theme.appearance
    }

    /// An empty accessory is the supported way to make the titlebar taller; it
    /// is hit-transparent so the page underneath keeps receiving clicks.
    private func growTitlebar(_ window: NSWindow) {
        let content = window.contentRect(forFrameRect: window.frame)
        let extra = HeaderMetrics.titlebarHeight - (window.frame.height - content.height)
        guard extra > 0 else { return }

        let accessory = NSTitlebarAccessoryViewController()
        accessory.layoutAttribute = .bottom
        accessory.view = PassthroughView(frame: NSRect(x: 0, y: 0, width: 1, height: extra))
        accessory.view.translatesAutoresizingMaskIntoConstraints = false
        accessory.view.heightAnchor.constraint(equalToConstant: extra).isActive = true
        window.addTitlebarAccessoryViewController(accessory)
    }

    final class Coordinator {
        var didConfigureChrome = false
        var appliedTheme: DashboardTheme?
        private var observers: [NSObjectProtocol] = []

        /// AppKit puts the buttons back in the top 28pt on resize and on
        /// full-screen transitions, so re-centre them whenever the window moves.
        func keepTrafficLightsCentered(on window: NSWindow) {
            let center = NotificationCenter.default
            for name in [
                NSWindow.didResizeNotification,
                NSWindow.didBecomeKeyNotification,
                NSWindow.didEnterFullScreenNotification,
                NSWindow.didExitFullScreenNotification,
            ] {
                let token = center.addObserver(forName: name, object: window, queue: .main) { note in
                    guard let window = note.object as? NSWindow else { return }
                    centerTrafficLights(in: window)
                }
                observers.append(token)
            }
        }

        deinit {
            observers.forEach(NotificationCenter.default.removeObserver)
        }
    }
}

/// Moves the traffic lights down into the grown titlebar so they land on the
/// dashboard's header row rather than in the top 28pt AppKit defaults them to.
private func centerTrafficLights(in window: NSWindow) {
    let buttons = [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton]
        .compactMap { window.standardWindowButton($0) }
    guard buttons.count == 3, let container = buttons[0].superview else { return }

    for button in buttons {
        // The titlebar container is unflipped, so y counts up from its bottom.
        let targetY = container.bounds.height - HeaderMetrics.rowCenterY - button.frame.height / 2
        guard abs(button.frame.origin.y - targetY) > 0.5 else { continue }
        button.setFrameOrigin(NSPoint(x: button.frame.origin.x, y: targetY))
    }
}

/// Lets mouse events fall through to the web view beneath the titlebar.
private final class PassthroughView: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
