import Foundation
import Testing

@Test func macOSAdapterSourceExcludesUnavailableCallKitAPIs() throws {
    let testFile = URL(fileURLWithPath: #filePath)
    let sourceDirectory = testFile
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .appending(path: "Sources/CallieAppleMacOS")
    let forbidden = ["Call" + "Kit", "CX" + "Call"]
    let files = try FileManager.default.contentsOfDirectory(at: sourceDirectory, includingPropertiesForKeys: nil)

    for file in files where file.pathExtension == "swift" {
        let source = try String(contentsOf: file, encoding: .utf8)
        for token in forbidden {
            #expect(!source.contains(token), "Forbidden unavailable macOS API token in \(file.lastPathComponent)")
        }
    }
}
