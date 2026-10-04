import Foundation

/// A task as the fixture service shows it to one signed-in client. The id is the service's, and it is the only thing
/// that names a task: titles repeat.
struct TaskRecord: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let done: Bool
    let revision: Int

    var stateText: String { done ? "Done" : "Open" }
}

/// The account a sign-in opened.
struct AccountRecord: Codable, Equatable, Sendable {
    let id: String
    let name: String
}

/// A sign-in that worked: the bearer token for later requests, kept in memory only, and who it signs in.
struct SignedIn: Sendable {
    let token: String
    let account: AccountRecord
}

/// A request that did not give the app what it asked for, in words the app can show.
enum ServiceError: LocalizedError, Equatable {
    case unreachable(String)
    case refused(status: Int, message: String)
    case unreadable

    var errorDescription: String? {
        switch self {
        case .unreachable(let reason): "Cannot reach the service: \(reason)"
        case .refused(_, let message): message
        case .unreadable: "The service sent an answer the app cannot read."
        }
    }

    var status: Int? {
        if case .refused(let status, _) = self { return status }
        return nil
    }
}

/// The fixture service's JSON API. Every request names the app in `x-task-client`. The URL session is ephemeral, with
/// no cache and no cookies, so the app keeps nothing on disk from its requests, and it follows no redirect, so a sign-in
/// is never sent on to another address. Each request writes one line to standard output: its method, its route, the
/// status and how long it took, and nothing else.
struct TaskServiceClient: Sendable {
    let baseURL: URL
    let clientName: String
    private let session: URLSession

    init(baseURL: URL, clientName: String) {
        self.baseURL = baseURL
        self.clientName = clientName
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        session = URLSession(configuration: configuration, delegate: RedirectRefusal(), delegateQueue: nil)
    }

    /// Asks whether the service answers.
    func health() async throws {
        let (status, data) = try await send("GET", ["api", "health"], route: "/api/health")
        try expect(200, status, data)
    }

    func signIn(account: String, password: String) async throws -> SignedIn {
        let body = try JSONEncoder().encode(["account": account, "password": password])
        let (status, data) = try await send("POST", ["api", "sign-in"], route: "/api/sign-in", json: body)
        try expect(200, status, data)
        return try decode(SignInAnswer.self, data).signedIn
    }

    /// The account's tasks this session can see, oldest first.
    func tasks(token: String) async throws -> [TaskRecord] {
        let (status, data) = try await send("GET", ["api", "tasks"], route: "/api/tasks", token: token)
        try expect(200, status, data)
        return try decode(TaskList.self, data).tasks
    }

    /// One task by id, or nil when no task with that id is visible to this session yet.
    func task(id: String, token: String) async throws -> TaskRecord? {
        let (status, data) = try await send("GET", ["api", "tasks", id], route: "/api/tasks/{id}", token: token)
        if status == 404 { return nil }
        try expect(200, status, data)
        return try decode(OneTask.self, data).task
    }

    /// Creates a task from a title. The service assigns its id.
    func createTask(title: String, token: String) async throws -> TaskRecord {
        let body = try JSONEncoder().encode(["title": title])
        let (status, data) = try await send("POST", ["api", "tasks"], route: "/api/tasks", token: token, json: body)
        try expect(201, status, data)
        return try decode(OneTask.self, data).task
    }

    private func send(_ method: String, _ path: [String], route: String, token: String? = nil, json: Data? = nil) async throws -> (Int, Data) {
        var url = baseURL
        for component in path { url.append(component: component) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(clientName, forHTTPHeaderField: "x-task-client")
        request.setValue("application/json", forHTTPHeaderField: "accept")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
        if let json {
            request.httpBody = json
            request.setValue("application/json", forHTTPHeaderField: "content-type")
        }
        let clock = ContinuousClock()
        let start = clock.now
        let answer: (Data, URLResponse)
        do {
            answer = try await session.data(for: request)
        } catch {
            RequestLine.write(method: method, route: route, outcome: "no answer", elapsed: start.duration(to: clock.now))
            throw ServiceError.unreachable(error.localizedDescription)
        }
        guard let response = answer.1 as? HTTPURLResponse else { throw ServiceError.unreadable }
        RequestLine.write(method: method, route: route, outcome: String(response.statusCode), elapsed: start.duration(to: clock.now))
        if (300..<400).contains(response.statusCode) {
            throw ServiceError.refused(status: response.statusCode, message: "The service answered with a redirect (\(response.statusCode)), which the app does not follow.")
        }
        return (response.statusCode, answer.0)
    }

    private func expect(_ wanted: Int, _ status: Int, _ data: Data) throws {
        guard status != wanted else { return }
        let message = (try? JSONDecoder().decode(ErrorAnswer.self, from: data))?.error ?? "The service answered \(status)."
        throw ServiceError.refused(status: status, message: message)
    }

    private func decode<Answer: Decodable>(_ type: Answer.Type, _ data: Data) throws -> Answer {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw ServiceError.unreadable
        }
    }
}

/// Hands a redirect back as the answer instead of following it.
private final class RedirectRefusal: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? {
        nil
    }
}

/// One line per request on standard output, written straight to the file descriptor so it is never held in a buffer.
private enum RequestLine {
    static func write(method: String, route: String, outcome: String, elapsed: Duration) {
        let milliseconds = elapsed.components.seconds * 1000 + elapsed.components.attoseconds / 1_000_000_000_000_000
        FileHandle.standardOutput.write(Data("\(method) \(route) \(outcome) \(milliseconds)ms\n".utf8))
    }
}

private struct SignInAnswer: Decodable {
    let token: String
    let account: AccountRecord

    var signedIn: SignedIn { SignedIn(token: token, account: account) }
}

private struct TaskList: Decodable {
    let tasks: [TaskRecord]
}

private struct OneTask: Decodable {
    let task: TaskRecord
}

private struct ErrorAnswer: Decodable {
    let error: String
}
