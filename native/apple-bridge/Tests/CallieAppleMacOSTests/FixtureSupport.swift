import Foundation
@testable import CallieAppleMacOS

enum FixtureSupport {
    static func snapshot(named name: String) throws -> AXNodeSnapshot {
        guard let url = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures") else {
            throw CocoaError(.fileNoSuchFile)
        }
        return try JSONDecoder().decode(AXNodeSnapshot.self, from: Data(contentsOf: url))
    }
}
