import Foundation

/// What an app reads at launch: where the fixture service is, and whether to start from a clean state.
///
/// The address comes from the `-serviceURL <url>` launch argument, or else the `RETEST_SERVICE_URL` environment
/// variable. There is no default address, so an app never talks to a service nobody named. Only a loopback address is
/// taken, so the app never reaches into the local network and the system never asks for local network access.
struct ServiceSettings: Equatable, Sendable {
    /// The service's address, when one was given and it is a loopback http address.
    let serviceURL: URL?
    /// Why there is no address, in words the app shows.
    let problem: String?
    /// `-reset` was given, alone or with a value other than `NO`: clear what the app keeps before reading any of it.
    let resetRequested: Bool

    static let argumentName = "-serviceURL"
    static let environmentName = "RETEST_SERVICE_URL"
    static let resetArgument = "-reset"

    static func read(
        arguments: [String] = CommandLine.arguments,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> ServiceSettings {
        let reset = resetRequested(arguments)
        if let index = arguments.firstIndex(of: argumentName) {
            // A flag without its address is a mistake to report, never a reason to read the variable instead.
            guard arguments.indices.contains(index + 1), !arguments[index + 1].hasPrefix("-") else {
                return refused("\(argumentName) needs an address after it, such as \(argumentName) http://127.0.0.1:4310.", reset: reset)
            }
            return settings(for: arguments[index + 1], reset: reset)
        }
        guard let given = environment[environmentName] else {
            return refused("No service address. Launch with \(argumentName) <url> or set \(environmentName).", reset: reset)
        }
        guard !given.isEmpty else { return refused("\(environmentName) is set but empty.", reset: reset) }
        return settings(for: given, reset: reset)
    }

    private static func settings(for given: String, reset: Bool) -> ServiceSettings {
        guard let url = URL(string: given), let scheme = url.scheme, ["http", "https"].contains(scheme), let host = url.host() else {
            return refused("Not an http address: \(given)", reset: reset)
        }
        guard isLoopback(host) else {
            return refused("Only a loopback address is taken, such as http://127.0.0.1:4310, not \(given).", reset: reset)
        }
        return ServiceSettings(serviceURL: url, problem: nil, resetRequested: reset)
    }

    private static func refused(_ problem: String, reset: Bool) -> ServiceSettings {
        ServiceSettings(serviceURL: nil, problem: problem, resetRequested: reset)
    }

    private static func isLoopback(_ host: String) -> Bool {
        let name = host.lowercased()
        if name == "localhost" || name == "::1" || name == "[::1]" { return true }
        let parts = name.split(separator: ".", omittingEmptySubsequences: false)
        return parts.count == 4 && parts[0] == "127" && parts.allSatisfy { part in UInt8(part) != nil }
    }

    // `-reset` alone, or before another flag, asks for a reset; `-reset NO`, `false` or `0` does not.
    private static func resetRequested(_ arguments: [String]) -> Bool {
        guard let index = arguments.firstIndex(of: resetArgument) else { return false }
        guard arguments.indices.contains(index + 1) else { return true }
        return !["no", "false", "0"].contains(arguments[index + 1].lowercased())
    }
}
