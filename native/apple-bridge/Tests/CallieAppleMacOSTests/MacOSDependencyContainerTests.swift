import CallieAppleProtocol
import Foundation
import Testing
@testable import CallieAppleMacOS

@Suite("MacOSDependencyContainerTests")
struct MacOSDependencyContainerTests {
    @Test func productionCompositionIsInertUntilTypedCommandAndUses0700Root() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "callie-container-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
        let nonexistentMessages = root.appending(path: "never-opened-chat.db")
        let container = try MacOSDependencyContainer(stagingRoot: root, messagesDatabase: nonexistentMessages)
        let attributes = try FileManager.default.attributesOfItem(atPath: container.stagingRoot.path)
        let permissions = (attributes[.posixPermissions] as? NSNumber)?.intValue

        #expect(permissions == 0o700)
        let hello = try BridgeRequest(
            id: UUID(),
            method: .hello,
            params: .hello(try .init(supportedVersions: [1]))
        )
        #expect(container.handler.handle(hello).ok)
        #expect(!FileManager.default.fileExists(atPath: nonexistentMessages.path))
        #expect(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
    }

    @Test func shutdownCleansOnlyGeneratedContainedEntries() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "callie-container-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
        let container = try MacOSDependencyContainer(stagingRoot: root, messagesDatabase: root.appending(path: "never-opened-chat.db"))
        let generated = root.appending(path: "callie-notes-11111111-1111-4111-8111-111111111111.export")
        let unrelated = root.appending(path: "keep.txt")
        try Data("abandoned synthetic".utf8).write(to: generated)
        try Data("keep".utf8).write(to: unrelated)
        let shutdown = try BridgeRequest(id: UUID(), method: .shutdown, params: .shutdown(.init()))

        #expect(container.handler.handle(shutdown).ok)
        #expect(!FileManager.default.fileExists(atPath: generated.path))
        #expect(FileManager.default.fileExists(atPath: unrelated.path))
    }
}
