import SwiftUI

/// TaskPhone, the iOS client of the cross-platform fixture: it signs in, creates a task from a title and shows the id
/// the service gave it. It keeps nothing of its own between launches: no defaults, no keychain item, no files.
@main
struct TaskPhoneApp: App {
    @State private var model = PhoneModel(settings: ServiceSettings.read())

    var body: some Scene {
        WindowGroup {
            PhoneView(model: model)
        }
    }
}
