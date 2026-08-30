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
        let helloResponse = container.handler.handle(hello)
        #expect(helloResponse.ok)
        #expect(helloResponse.result == [
            "selectedVersion": .number(1),
            "helperVersion": .string("1.0.0"),
        ])
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

        let response = container.handler.handle(shutdown)
        #expect(response.v == 1)
        #expect(response.ok)
        #expect(response.result == ["shuttingDown": .bool(true)])
        #expect(response.error == nil)
        #expect(!FileManager.default.fileExists(atPath: generated.path))
        #expect(FileManager.default.fileExists(atPath: unrelated.path))
    }

    @Test func shutdownCleanupFailureReturnsSanitizedErrorAndNeverClaimsSuccess() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "callie-container-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
        let container = try MacOSDependencyContainer(stagingRoot: root, messagesDatabase: root.appending(path: "never-opened-chat.db"))
        let generatedDirectory = root.appending(path: "callie-notes-export-11111111-1111-4111-8111-111111111111", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: generatedDirectory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let retainedSyntheticPath = generatedDirectory.appending(path: "unexpected-private-sidecar")
        try Data("synthetic retained bytes".utf8).write(to: retainedSyntheticPath)
        let requestID = UUID(uuidString: "77777777-7777-4777-8777-777777777777")!
        let shutdown = try BridgeRequest(id: requestID, method: .shutdown, params: .shutdown(.init()))

        let response = container.handler.handle(shutdown)

        #expect(response.v == 1)
        #expect(response.id == requestID)
        #expect(!response.ok)
        #expect(response.result == nil)
        #expect(response.error?.code == .internalError)
        #expect(response.error?.message == "Bridge shutdown cleanup could not be verified.")
        #expect(response.error?.retryable == false)
        #expect(!String(describing: response.error).contains(root.path))
        #expect(FileManager.default.fileExists(atPath: retainedSyntheticPath.path))
    }
}
