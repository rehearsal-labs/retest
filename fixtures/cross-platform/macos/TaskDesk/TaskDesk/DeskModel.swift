import Foundation
import Observation

/// TaskDesk's state. While signed in it asks for the task list once a second, since a change another client made
/// reaches this one only after the service's sync delay.
@MainActor
@Observable
final class DeskModel {
    let settings: ServiceSettings
    private let client: TaskServiceClient?

    var serviceStatus: String
    var accountText: String
    var passwordText = ""
    var signInError = ""
    var signingIn = false
    private(set) var token: String?
    private(set) var account: AccountRecord?

    private(set) var tasks: [TaskRecord] = []
    private(set) var listStatus = ""
    /// What the task id field holds.
    var lookupText = ""
    /// The id of the task shown on its own, whether or not it is visible yet.
    private(set) var shownId: String?

    init(settings: ServiceSettings) {
        self.settings = settings
        client = settings.serviceURL.map { TaskServiceClient(baseURL: $0, clientName: "macos") }
        serviceStatus = settings.problem ?? "Connecting to \(settings.serviceURL?.absoluteString ?? "")"
        accountText = UserDefaults.standard.string(forKey: DeskDefaults.lastAccountKey) ?? ""
    }

    /// The shown task as this session sees it, or nil while it is not visible.
    var shownTask: TaskRecord? {
        guard let shownId else { return nil }
        return tasks.first { $0.id == shownId }
    }

    func checkService() async {
        guard let client else { return }
        do {
            try await client.health()
            serviceStatus = "Connected to \(client.baseURL.absoluteString)"
            DeskLog.write("service answered")
        } catch {
            serviceStatus = error.localizedDescription
            DeskLog.write("service did not answer")
        }
    }

    func signIn() async {
        guard let client, !signingIn else { return }
        signingIn = true
        signInError = ""
        defer { signingIn = false }
        do {
            let signedIn = try await client.signIn(account: accountText.trimmingCharacters(in: .whitespaces), password: passwordText)
            passwordText = ""
            token = signedIn.token
            account = signedIn.account
            UserDefaults.standard.set(signedIn.account.id, forKey: DeskDefaults.lastAccountKey)
        } catch {
            passwordText = ""
            signInError = error.localizedDescription
        }
    }

    func signOut() {
        token = nil
        account = nil
        tasks = []
        shownId = nil
        listStatus = ""
    }

    /// Refreshes the list until the session ends or the view goes away.
    func followTasks() async {
        while !Task.isCancelled, let token {
            await refresh(token: token)
            try? await Task.sleep(for: .seconds(1))
        }
    }

    func showLookup() {
        let id = lookupText.trimmingCharacters(in: .whitespaces)
        if !id.isEmpty { shownId = id }
    }

    func show(id: String) {
        lookupText = id
        shownId = id
    }

    private func refresh(token: String) async {
        guard let client else { return }
        do {
            let latest = try await client.tasks(token: token)
            guard token == self.token else { return }
            tasks = latest
            listStatus = latest.count == 1 ? "1 task" : "\(latest.count) tasks"
        } catch let error as ServiceError where error.status == 401 {
            signOut()
            signInError = "Your session ended. Sign in again."
        } catch {
            listStatus = error.localizedDescription
        }
    }
}
