import Foundation

// Checks of the Swift the fixture apps compile, run by tests/integration/cross-platform-service.test.ts, which builds
// this file with ../ServiceSettings.swift, ../TaskServiceClient.swift and ../WindowFrame.swift and runs it as
// `checks <address that redirects every request to the service> <the service's address>`, with the seeded account
// ada's password in CHECK_PASSWORD. It prints `ok <check>` or `fail <check> <what it saw>` for each check, the client's
// own line for each request, and exits 1 when any check failed.

var failures = 0

@MainActor func check(_ name: String, _ passed: Bool, _ seen: String = "") {
    if passed {
        print("ok \(name)")
    } else {
        failures += 1
        print("fail \(name) \(seen)")
    }
}

@MainActor func checkSettings() {
    let fallback = ["RETEST_SERVICE_URL": "http://127.0.0.1:4310"]
    let none = ServiceSettings.read(arguments: ["app"], environment: [:])
    check("no address is refused", none.serviceURL == nil && none.problem != nil, "\(none)")
    let fromVariable = ServiceSettings.read(arguments: ["app"], environment: fallback)
    check("the variable gives the address", fromVariable.serviceURL?.absoluteString == "http://127.0.0.1:4310", "\(fromVariable)")
    let missing = ServiceSettings.read(arguments: ["app", "-serviceURL"], environment: fallback)
    check("-serviceURL with no value is refused, not replaced by the variable", missing.serviceURL == nil && missing.problem != nil, "\(missing)")
    let flagAfter = ServiceSettings.read(arguments: ["app", "-serviceURL", "-reset"], environment: fallback)
    check("-serviceURL followed by a flag is refused", flagAfter.serviceURL == nil && flagAfter.resetRequested, "\(flagAfter)")
    let argument = ServiceSettings.read(arguments: ["app", "-serviceURL", "http://127.0.0.1:5000"], environment: fallback)
    check("the argument wins over the variable", argument.serviceURL?.absoluteString == "http://127.0.0.1:5000", "\(argument)")
    for (arguments, wanted) in [(["app", "-reset"], true), (["app", "-reset", "YES"], true), (["app", "-reset", "-serviceURL", "http://127.0.0.1:1"], true), (["app", "-reset", "NO"], false), (["app", "-reset", "false"], false), (["app"], false)] {
        let settings = ServiceSettings.read(arguments: arguments, environment: fallback)
        check("reset is \(wanted) for \(arguments.dropFirst().joined(separator: " "))", settings.resetRequested == wanted, "\(settings.resetRequested)")
    }
    for address in ["http://127.0.0.1:4310", "http://localhost:4310", "http://[::1]:4310", "http://127.0.0.2:4310"] {
        let settings = ServiceSettings.read(arguments: ["app", "-serviceURL", address], environment: [:])
        check("loopback \(address) is taken", settings.serviceURL != nil, "\(settings)")
    }
    for address in ["http://192.168.1.10:4310", "http://10.0.0.2:4310", "http://example.com:4310", "http://128.0.0.1:4310", "http://127.0.0.1.example.com", "ftp://127.0.0.1:4310"] {
        let settings = ServiceSettings.read(arguments: ["app", "-serviceURL", address], environment: [:])
        check("\(address) is refused", settings.serviceURL == nil && settings.problem != nil, "\(settings)")
    }
}

@MainActor func checkWindowFrame() {
    let absent = WindowFrame.read(arguments: ["app", "-serviceURL", "http://127.0.0.1:4310"])
    check("no -windowFrame leaves the window alone", absent.frame == nil && absent.problem == nil, "\(absent)")
    let plain = WindowFrame.read(arguments: ["app", "-windowFrame", "20,60,700,480", "-reset"])
    check("-windowFrame 20,60,700,480 is read", plain.frame == WindowFrame(x: 20, y: 60, width: 700, height: 480) && plain.problem == nil, "\(plain)")
    let spaced = WindowFrame.read(arguments: ["app", "-windowFrame", "10.5, 20 ,700,480"])
    check("-windowFrame takes decimals and spaces", spaced.frame == WindowFrame(x: 10.5, y: 20, width: 700, height: 480), "\(spaced)")
    for arguments in [["app", "-windowFrame"], ["app", "-windowFrame", "-reset"]] {
        let reading = WindowFrame.read(arguments: arguments)
        check("\(arguments.dropFirst().joined(separator: " ")) is refused", reading.frame == nil && reading.problem != nil, "\(reading)")
    }
    for given in ["20,60,700", "20,60,700,480,1", "a,60,700,480", "20,60,0,480", "20,60,700,100", "-5,60,700,480", "20,60,nan,480", "20,60,inf,480", ""] {
        let reading = WindowFrame.read(arguments: ["app", "-windowFrame", given])
        check("-windowFrame \"\(given)\" is refused", reading.frame == nil && reading.problem != nil, "\(reading)")
    }
}

@MainActor func checkRedirects(_ redirecting: URL, password: String) async {
    let client = TaskServiceClient(baseURL: redirecting, clientName: "test")
    do {
        try await client.health()
        check("a redirected health check is not followed", false, "it answered")
    } catch {
        check("a redirected health check is not followed", (error as? ServiceError)?.status == 307, "\(error)")
    }
    do {
        _ = try await client.signIn(account: "ada", password: password)
        check("a redirected sign-in is not sent on", false, "it signed in")
    } catch {
        check("a redirected sign-in is not sent on", (error as? ServiceError)?.status == 307, "\(error)")
    }
}

@MainActor func checkService(_ service: URL, password: String) async {
    let client = TaskServiceClient(baseURL: service, clientName: "test")
    do {
        try await client.health()
        let signedIn = try await client.signIn(account: "ada", password: password)
        let created = try await client.createTask(title: "Made by the Swift checks", token: signedIn.token)
        let read = try await client.task(id: created.id, token: signedIn.token)
        let listed = try await client.tasks(token: signedIn.token)
        let missing = try await client.task(id: "task-000000000000", token: signedIn.token)
        check("the client signs in, creates, reads and lists by id", read == created && listed.contains(created) && missing == nil, "\(String(describing: read))")
    } catch {
        check("the client signs in, creates, reads and lists by id", false, "\(error)")
    }
}

let arguments = CommandLine.arguments
let password = ProcessInfo.processInfo.environment["CHECK_PASSWORD"] ?? ""
guard arguments.count == 3, let redirecting = URL(string: arguments[1]), let service = URL(string: arguments[2]), !password.isEmpty else {
    print("fail usage: checks <redirecting address> <service address>, with CHECK_PASSWORD set")
    exit(2)
}
checkSettings()
checkWindowFrame()
await checkRedirects(redirecting, password: password)
await checkService(service, password: password)
exit(failures == 0 ? 0 : 1)
