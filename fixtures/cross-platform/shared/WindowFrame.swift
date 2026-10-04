import Foundation

/// Where TaskDesk puts its window at launch, from `-windowFrame x,y,width,height`: the whole window, title bar
/// included, in screen points with the origin at the top left of the main display, as the window server reports
/// window bounds. Without the argument the window opens where macOS puts it.
struct WindowFrame: Equatable, Sendable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    static let argumentName = "-windowFrame"
    /// The smallest window that holds TaskDesk's content, title bar included.
    static let minimumWidth = 640.0
    static let minimumHeight = 460.0

    /// The frame the arguments ask for, or why it was refused. Both are nil when the argument is absent.
    struct Reading: Equatable, Sendable {
        let frame: WindowFrame?
        let problem: String?
    }

    static func read(arguments: [String] = CommandLine.arguments) -> Reading {
        guard let index = arguments.firstIndex(of: argumentName) else { return Reading(frame: nil, problem: nil) }
        let example = "such as \(argumentName) 20,60,700,480"
        guard arguments.indices.contains(index + 1), !arguments[index + 1].hasPrefix("-") else {
            return refused("\(argumentName) needs x,y,width,height after it, \(example).")
        }
        let given = arguments[index + 1]
        let numbers = given.split(separator: ",", omittingEmptySubsequences: false).map { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard numbers.count == 4, let x = numbers[0], let y = numbers[1], let width = numbers[2], let height = numbers[3] else {
            return refused("\(argumentName) takes four numbers, x,y,width,height, \(example), not \(given).")
        }
        guard [x, y, width, height].allSatisfy(\.isFinite), x >= 0, y >= 0 else {
            return refused("\(argumentName) takes finite numbers with x and y at least 0, not \(given).")
        }
        guard width >= minimumWidth, height >= minimumHeight else {
            return refused("\(argumentName) needs a window at least \(Int(minimumWidth)) wide and \(Int(minimumHeight)) high, not \(given).")
        }
        return Reading(frame: WindowFrame(x: x, y: y, width: width, height: height), problem: nil)
    }

    /// The frame as the app's lines write it: `x,y,width,height`, whole numbers where they are whole.
    var text: String {
        [x, y, width, height].map { $0.rounded() == $0 ? String(Int($0)) : String($0) }.joined(separator: ",")
    }

    private static func refused(_ problem: String) -> Reading {
        Reading(frame: nil, problem: problem)
    }
}
