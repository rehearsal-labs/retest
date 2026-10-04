import AppKit
import SwiftUI

/// TaskDesk's one window. Every control and every value a test reads has an accessibility identifier; those of a task
/// end with the task's id, so a test names the task, never its title.
struct DeskView: View {
    @Bindable var model: DeskModel
    /// Where `-windowFrame` asked for the window, if it did.
    let windowFrame: WindowFrame?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(model.serviceStatus)
                .font(.callout)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("service-status")
            if let account = model.account {
                signedIn(account)
            } else {
                signInForm
            }
            Spacer(minLength: 0)
        }
        .padding(20)
        .frame(minWidth: 640, minHeight: 420, alignment: .topLeading)
        .background { if let windowFrame { WindowPlacer(frame: windowFrame) } }
        .onAppear { DeskLog.write("window shown") }
        .task { await model.checkService() }
    }

    private var signInForm: some View {
        Form {
            TextField("Account", text: $model.accountText)
                .accessibilityIdentifier("account-field")
            SecureField("Password", text: $model.passwordText)
                .accessibilityIdentifier("password-field")
            Button("Sign in") { Task { await model.signIn() } }
                .keyboardShortcut(.defaultAction)
                .disabled(model.signingIn || model.settings.serviceURL == nil)
                .accessibilityIdentifier("sign-in-button")
            if !model.signInError.isEmpty {
                Text(model.signInError)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("sign-in-error")
            }
        }
        .frame(maxWidth: 360)
    }

    private func signedIn(_ account: AccountRecord) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Signed in as")
                Text(account.id)
                    .bold()
                    .accessibilityIdentifier("signed-in-account")
                Spacer()
                Button("Sign out") { model.signOut() }
                    .accessibilityIdentifier("sign-out-button")
            }
            .accessibilityElement(children: .contain)
            HStack {
                TextField("Task id", text: $model.lookupText)
                    .frame(maxWidth: 280)
                    .onSubmit { model.showLookup() }
                    .accessibilityIdentifier("task-id-field")
                Button("Show") { model.showLookup() }
                    .accessibilityIdentifier("show-task-button")
            }
            shownTask
            Text(model.listStatus)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("task-count")
            taskList
        }
        .task(id: model.token) { await model.followTasks() }
    }

    // Plain text views, each with its own identifier, inside containers that keep their children apart: a labelled row
    // that merged its label and value into one element would hide the identifier a test reads.
    @ViewBuilder
    private var shownTask: some View {
        if let id = model.shownId {
            GroupBox {
                VStack(alignment: .leading, spacing: 6) {
                    FactRow(label: "Id", value: id, identifier: "selected-task-id", monospaced: true)
                    if let task = model.shownTask {
                        FactRow(label: "Title", value: task.title, identifier: "selected-task-title")
                        FactRow(label: "State", value: task.stateText, identifier: "selected-task-state")
                        FactRow(label: "Revision", value: String(task.revision), identifier: "selected-task-revision")
                    } else {
                        Text("No task with this id is visible to you yet.")
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("selected-task-missing")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .contain)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("selected-task")
        }
    }

    private var taskList: some View {
        List(model.tasks) { task in
            HStack(spacing: 16) {
                Text(task.id)
                    .monospaced()
                    .frame(width: 170, alignment: .leading)
                    .accessibilityIdentifier("task-id-\(task.id)")
                Text(task.title)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("task-title-\(task.id)")
                Text(task.stateText)
                    .frame(width: 60, alignment: .leading)
                    .accessibilityIdentifier("task-state-\(task.id)")
                Button("Show") { model.show(id: task.id) }
                    .accessibilityIdentifier("show-task-\(task.id)")
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("task-row-\(task.id)")
        }
        .accessibilityIdentifier("task-list")
    }
}

/// A label and a value side by side, the value a text view of its own carrying the identifier.
private struct FactRow: View {
    let label: String
    let value: String
    let identifier: String
    var monospaced = false

    var body: some View {
        HStack(spacing: 12) {
            Text(label)
                .foregroundStyle(.secondary)
                .frame(width: 70, alignment: .leading)
            Text(value)
                .monospaced(monospaced)
                .accessibilityIdentifier(identifier)
        }
        .accessibilityElement(children: .contain)
    }
}

/// Puts the window it is drawn in at a frame given with the origin at the top left of the main display, once, when it
/// first joins the window, and writes the frame the window then has.
private struct WindowPlacer: NSViewRepresentable {
    let frame: WindowFrame

    func makeNSView(context: Context) -> PlacingView {
        PlacingView(frame: frame)
    }

    func updateNSView(_ view: PlacingView, context: Context) {}

    final class PlacingView: NSView {
        private let wanted: WindowFrame
        private var placed = false

        init(frame wanted: WindowFrame) {
            self.wanted = wanted
            super.init(frame: .zero)
        }

        required init?(coder: NSCoder) {
            nil
        }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard !placed, let window, let mainHeight = NSScreen.screens.first?.frame.height else { return }
            placed = true
            // AppKit counts from the bottom left of the main display; the argument, like the window server, from the top left.
            let bottom = mainHeight - wanted.y - wanted.height
            window.setFrame(NSRect(x: wanted.x, y: bottom, width: wanted.width, height: wanted.height), display: true)
            let now = window.frame
            let taken = WindowFrame(x: now.minX, y: mainHeight - now.maxY, width: now.width, height: now.height)
            DeskLog.write("window frame asked \(wanted.text), now \(taken.text)")
        }
    }
}
