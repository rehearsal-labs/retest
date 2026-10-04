import SwiftUI

/// TaskPhone's one screen. Every control and every value a test reads has an accessibility identifier.
struct PhoneView: View {
    @Bindable var model: PhoneModel

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(model.serviceStatus)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("service-status")
                }
                if let account = model.account {
                    signedIn(account)
                } else {
                    signInSection
                }
            }
            .navigationTitle("TaskPhone")
        }
        .task { await model.checkService() }
    }

    private var signInSection: some View {
        Section("Sign in") {
            TextField("Account", text: $model.accountText)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textContentType(.username)
                .accessibilityIdentifier("account-field")
            SecureField("Password", text: $model.passwordText)
                .textContentType(.password)
                .accessibilityIdentifier("password-field")
            Button("Sign in") { Task { await model.signIn() } }
                .disabled(model.busy || model.settings.serviceURL == nil)
                .accessibilityIdentifier("sign-in-button")
            if !model.signInError.isEmpty {
                Text(model.signInError)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("sign-in-error")
            }
        }
    }

    @ViewBuilder
    private func signedIn(_ account: AccountRecord) -> some View {
        Section("Signed in") {
            FactRow(label: "Account", value: account.id, identifier: "signed-in-account")
            Button("Sign out", role: .destructive) { model.signOut() }
                .accessibilityIdentifier("sign-out-button")
        }
        Section("New task") {
            TextField("Title", text: $model.newTitle)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .accessibilityIdentifier("new-task-title-field")
            Button("Create task") { Task { await model.createTask() } }
                .disabled(model.busy || model.newTitle.trimmingCharacters(in: .whitespaces).isEmpty)
                .accessibilityIdentifier("create-task-button")
            if !model.createError.isEmpty {
                Text(model.createError)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("create-error")
            }
        }
        if let task = model.created {
            Section("Created") {
                FactRow(label: "Id", value: task.id, identifier: "created-task-id", monospaced: true)
                FactRow(label: "Title", value: task.title, identifier: "created-task-title")
                FactRow(label: "State", value: task.stateText, identifier: "created-task-state")
            }
        }
    }
}

/// A label and a value side by side, the value a text view of its own carrying the identifier. A labelled row that
/// merged its label and value into one element would hide the identifier a test reads.
private struct FactRow: View {
    let label: String
    let value: String
    let identifier: String
    var monospaced = false

    var body: some View {
        HStack(spacing: 12) {
            Text(label)
                .foregroundStyle(.secondary)
            Spacer(minLength: 12)
            Text(value)
                .monospaced(monospaced)
                .textSelection(.enabled)
                .accessibilityIdentifier(identifier)
        }
        .accessibilityElement(children: .contain)
    }
}
