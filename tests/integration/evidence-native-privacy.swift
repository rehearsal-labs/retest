import AppKit
import Vision

struct Input: Decodable { let secret: String; let images: [String] }
let input = try JSONDecoder().decode(Input.self, from: FileHandle.standardInput.readDataToEndOfFile())
func normalized(_ text: String) -> String { text.lowercased().filter { !$0.isWhitespace } }
let secret = normalized(input.secret)
func containsSecret(_ image: CGImage) throws -> Bool {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    request.recognitionLanguages = ["en-US"]
    try VNImageRequestHandler(cgImage: image).perform([request])
    let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
    return normalized(text).contains(secret)
}
func control(_ text: String) -> CGImage {
    let image = NSImage(size: NSSize(width: 1200, height: 100))
    image.lockFocus()
    NSColor.white.setFill()
    NSBezierPath(rect: NSRect(x: 0, y: 0, width: 1200, height: 100)).fill()
    (text as NSString).draw(at: NSPoint(x: 20, y: 20), withAttributes: [.font: NSFont.monospacedSystemFont(ofSize: 32, weight: .regular), .foregroundColor: NSColor.black])
    image.unlockFocus()
    return image.cgImage(forProposedRect: nil, context: nil, hints: nil)!
}
guard !secret.isEmpty, try containsSecret(control(input.secret)), try !containsSecret(control(String(repeating: "•", count: input.secret.count))) else {
    throw NSError(domain: "RetestPixelPrivacyControl", code: 1)
}
var matches = 0
for path in input.images {
    try autoreleasepool {
        guard let image = NSImage(contentsOfFile: path)?.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            throw NSError(domain: "RetestPixelPrivacyImage", code: 1)
        }
        if try containsSecret(image) { matches += 1 }
    }
}
let result = ["imagesChecked": input.images.count, "recognizedSecretImages": matches, "positiveControls": 1, "maskedControls": 1]
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]))
