import Foundation
import Observation

/// TaskPhone's state. The sign-in token lives in memory only, so every launch starts signed out.
@MainActor
@Observable
final class PhoneModel {
    let settings: ServiceSettings
    private let client: TaskServiceClient?

    var serviceStatus: String
    var accountText = ""
    var passwordText = ""
    var signInError = ""
    var busy = false
    private(set) var token: String?
    private(set) var account: AccountRecord?

    var newTitle = ""
    var createError = ""
    /// The last task this app created, as the service answered.
    private(set) var created: TaskRecord?

    init(settings: ServiceSettings) {
        self.settings = settings
        client = settings.serviceURL.map { TaskServiceClient(baseURL: $0, clientName: "ios") }
        serviceStatus = settings.problem ?? "Connecting to \(settings.serviceURL?.absoluteString ?? "")"
    }

    func checkService() async {
        guard let client else { return }
        do {
            try await client.health()
            serviceStatus = "Connected to \(client.baseURL.absoluteString)"
        } catch {
            serviceStatus = error.localizedDescription
        }
    }

    func signIn() async {
        guard let client, !busy else { return }
        busy = true
        signInError = ""
        defer { busy = false }
        do {
            let signedIn = try await client.signIn(account: accountText.trimmingCharacters(in: .whitespaces), password: passwordText)
            passwordText = ""
            token = signedIn.token
            account = signedIn.account
        } catch {
            passwordText = ""
            signInError = error.localizedDescription
        }
    }

    func signOut() {
        token = nil
        account = nil
        created = nil
        newTitle = ""
        createError = ""
    }

    /// Sends the title once. A request that fails is reported, never sent again on its own.
    func createTask() async {
        guard let client, let token, !busy else { return }
        busy = true
        createError = ""
        defer { busy = false }
        do {
            created = try await client.createTask(title: newTitle, token: token)
            newTitle = ""
        } catch let error as ServiceError where error.status == 401 {
            signOut()
            signInError = "Your session ended. Sign in again."
        } catch {
            createError = error.localizedDescription
        }
    }
}
