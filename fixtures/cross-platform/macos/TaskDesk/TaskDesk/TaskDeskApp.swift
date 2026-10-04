import AppKit
import SwiftUI

/// TaskDesk, the macOS client of the cross-platform fixture: it signs in, lists the account's tasks with their ids and
/// shows one task's state. It keeps nothing of its own beyond `UserDefaults`, and `-reset` clears that at launch.
@main
struct TaskDeskApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var model: DeskModel
    private let windowFrame: WindowFrame?

    init() {
        // AppKit pairs launch arguments as `-key value`, so in `-reset -serviceURL http://…` the address is left on its
        // own and AppKit opens it as a URL at launch, and SwiftUI then opens no window. Registered, not saved.
        UserDefaults.standard.register(defaults: ["NSTreatUnknownArgumentsAsOpen": "NO"])
        let settings = ServiceSettings.read()
        if settings.resetRequested { DeskDefaults.clear() }
        DeskLog.write("started, service \(settings.serviceURL?.absoluteString ?? "not set"), reset \(settings.resetRequested)")
        let frame = WindowFrame.read()
        if let problem = frame.problem { DeskLog.write("window frame refused: \(problem)") }
        windowFrame = frame.frame
        _model = State(initialValue: DeskModel(settings: settings))
    }

    var body: some Scene {
        Window("TaskDesk", id: "main") {
            DeskView(model: model, windowFrame: windowFrame)
        }
        .defaultSize(width: 820, height: 560)
        // A window the system brings back on its own would be state from an earlier run.
        .restorationBehavior(.disabled)
    }
}

/// Quits on SIGTERM the way the Quit command does, so a test that stops the app gets a clean termination rather than
/// a killed process, and stops the app when its one window closes.
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var termination: DispatchSourceSignal?

    func applicationDidFinishLaunching(_ notification: Notification) {
        signal(SIGTERM, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        source.setEventHandler {
            MainActor.assumeIsolated {
                DeskLog.write("SIGTERM received, quitting")
                NSApplication.shared.terminate(nil)
            }
        }
        source.resume()
        termination = source
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
        true
    }

    func application(_ app: NSApplication, shouldSaveSecureApplicationState coder: NSCoder) -> Bool {
        false
    }

    func application(_ app: NSApplication, shouldRestoreSecureApplicationState coder: NSCoder) -> Bool {
        false
    }

    func applicationWillTerminate(_ notification: Notification) {
        DeskLog.write("terminating")
    }
}

/// The only things TaskDesk keeps between launches, all in its `UserDefaults` domain.
enum DeskDefaults {
    /// The account last signed in to, offered again in the sign-in form. Never a password or a token.
    static let lastAccountKey = "lastAccount"

    /// Removes the whole domain, which also holds what AppKit keeps there, such as the window's frame.
    static func clear() {
        guard let domain = Bundle.main.bundleIdentifier else { return }
        UserDefaults.standard.removePersistentDomain(forName: domain)
    }
}

/// One line per lifecycle event on standard error, so a test that launched the app can tell what it did without
/// driving it. It never writes an account's password, a token or a task title.
enum DeskLog {
    static func write(_ message: String) {
        FileHandle.standardError.write(Data("TaskDesk: \(message)\n".utf8))
    }
}
