import Foundation
import ServiceManagement

/// "Start cot at login" — SMAppService registers the whole app bundle, so the
/// collector comes back with it.
enum LoginItem {
    static var isEnabled: Bool {
        SMAppService.mainApp.status == .enabled
    }

    @discardableResult
    static func setEnabled(_ enabled: Bool) -> Bool {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            return true
        } catch {
            NSLog("cot: login item update failed — \(error.localizedDescription)")
            return false
        }
    }
}
