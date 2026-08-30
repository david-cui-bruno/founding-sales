import Foundation
import Testing
@testable import CallieAppleCore
@testable import CallieAppleMacOS

@Suite("NotesAdapterTests")
struct NotesAdapterTests {
    @Test func emptyScanReplyReturnsNoArtifacts() throws {
        let locator = NotesRecordingLocator(
            executor: FakeAppleEventExecutor(reply: .list()),
            registry: NotesArtifactRegistry()
        )

        #expect(try locator.scan(since: fixtureDate).isEmpty)
    }

    @Test func scanReturnsOpaqueDeduplicatedAudioArtifactsWithoutTranscriptDependency() throws {
        let executor = FakeAppleEventExecutor(reply: notesReply([
            ("private-attachment-a", "Call Recording.m4a", fixtureDate),
            ("private-attachment-a", "Call Recording.m4a", fixtureDate),
            ("private-attachment-b", "Transcript.txt", fixtureDate),
        ]))
        let registry = NotesArtifactRegistry()
        let locator = NotesRecordingLocator(executor: executor, registry: registry)

        let first = try locator.scan(since: fixtureDate.addingTimeInterval(-1))
        let second = try locator.scan(since: fixtureDate.addingTimeInterval(-1))

        #expect(first.count == 1)
        #expect(second.map(\.id) == first.map(\.id))
        #expect(first[0].createdAt == fixtureDate)
        #expect(executor.operations == [.notesScanAttachments, .notesScanAttachments])
    }

    @Test func fixedDescriptorsUseConstantTargetsAndDataDescriptors() throws {
        let hostileBody = #"synthetic\"; arbitrary source"#
        let message = try FixedAppleEventDescriptorFactory.descriptor(
            for: .messagesSend(handle: "synthetic@example.invalid", body: hostileBody)
        )
        #expect(message.eventClass == fourCC("icht"))
        #expect(message.eventID == fourCC("send"))
        #expect(message.paramDescriptor(forKeyword: fourCC("----"))?.stringValue == hostileBody)
        let recipient = message.paramDescriptor(forKeyword: fourCC("TO  "))
        #expect(recipient?.forKeyword(fourCC("seld"))?.stringValue == "synthetic@example.invalid")
        let messageTarget = message.attributeDescriptor(forKeyword: fourCC("addr"))
        #expect(messageTarget?.descriptorType == fourCC("bund"))
        #expect(messageTarget?.data == Data("com.apple.MobileSMS".utf8))

        let save = try FixedAppleEventDescriptorFactory.descriptor(
            for: .notesSaveAttachment(
                scriptingID: "opaque-private-id",
                destination: URL(fileURLWithPath: "/private/tmp/generated-only.export")
            )
        )
        #expect(save.eventClass == fourCC("core"))
        #expect(save.eventID == fourCC("save"))
        let notesTarget = save.attributeDescriptor(forKeyword: fourCC("addr"))
        #expect(notesTarget?.descriptorType == fourCC("bund"))
        #expect(notesTarget?.data == Data("com.apple.Notes".utf8))
        #expect(save.paramDescriptor(forKeyword: fourCC("kfil"))?.fileURLValue?.path == "/private/tmp/generated-only.export")
    }

    @Test func exportHashesCountsDeletesAndReturnsNoPath() throws {
        let root = try notesTemporaryDirectory()
        let registry = NotesArtifactRegistry()
        let id = registry.register(scriptingID: "private-attachment-a", createdAt: fixtureDate)
        let payload = Data("synthetic recording bytes".utf8)
        let executor = FakeAppleEventExecutor(reply: .null(), onOperation: { operation in
            guard case let .notesSaveAttachment(_, destination) = operation else { return }
            try payload.write(to: destination, options: .withoutOverwriting)
        })
        let exporter = try NotesAttachmentExporter(executor: executor, registry: registry, stagingRoot: root)

        let proof = try exporter.proveExport(id: id)

        #expect(proof.artifactID == id)
        #expect(proof.byteCount == 25)
        #expect(proof.sha256 == "747717e7925bc4bb4ab4938d448598d2676afbdd87495695306bf08b475408e4")
        #expect(!proof.plaintextRetained)
        #expect(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
    }

    @Test func exportDeletesPlaintextWhenExecutorThrowsAfterWriting() throws {
        let root = try notesTemporaryDirectory()
        let registry = NotesArtifactRegistry()
        let id = registry.register(scriptingID: "private-attachment-a", createdAt: fixtureDate)
        let executor = FakeAppleEventExecutor(reply: .null(), onOperation: { operation in
            guard case let .notesSaveAttachment(_, destination) = operation else { return }
            try Data("sensitive synthetic bytes".utf8).write(to: destination, options: .withoutOverwriting)
            throw AppleEventExecutionError.failed
        })
        let exporter = try NotesAttachmentExporter(executor: executor, registry: registry, stagingRoot: root)

        #expect(throws: NotesAdapterError.exportFailed) { try exporter.proveExport(id: id) }
        #expect(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
    }

    @Test func exportErrorRemovesDanglingSymlinkEntryWithoutTouchingItsTarget() throws {
        let root = try notesTemporaryDirectory()
        let outside = try notesTemporaryDirectory()
        let outsideTarget = outside.appending(path: "must-not-exist")
        let registry = NotesArtifactRegistry()
        let id = registry.register(scriptingID: "private-attachment-a", createdAt: fixtureDate)
        let executor = FakeAppleEventExecutor(reply: .null(), onOperation: { operation in
            guard case let .notesSaveAttachment(_, destination) = operation else { return }
            try FileManager.default.createSymbolicLink(at: destination, withDestinationURL: outsideTarget)
            throw AppleEventExecutionError.failed
        })
        let exporter = try NotesAttachmentExporter(executor: executor, registry: registry, stagingRoot: root)

        #expect(throws: NotesAdapterError.exportFailed) { try exporter.proveExport(id: id) }
        #expect(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
        #expect(!FileManager.default.fileExists(atPath: outsideTarget.path))
    }

    @Test func cleanupOnlyRemovesGeneratedImmediateStagingFiles() throws {
        let root = try notesTemporaryDirectory()
        let generated = root.appending(path: "callie-notes-11111111-1111-4111-8111-111111111111.export")
        let unrelated = root.appending(path: "unrelated.keep")
        try Data("abandoned".utf8).write(to: generated)
        try Data("keep".utf8).write(to: unrelated)
        let exporter = try NotesAttachmentExporter(
            executor: FakeAppleEventExecutor(reply: .null()),
            registry: NotesArtifactRegistry(),
            stagingRoot: root
        )

        try exporter.cleanAbandonedArtifacts()

        #expect(!FileManager.default.fileExists(atPath: generated.path))
        #expect(FileManager.default.fileExists(atPath: unrelated.path))
    }
}

private let fixtureDate = Date(timeIntervalSince1970: 1_800_000_000)

private func notesTemporaryDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appending(path: "callie-notes-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    return url
}

private func notesReply(_ rows: [(String, String, Date)]) -> NSAppleEventDescriptor {
    let list = NSAppleEventDescriptor.list()
    for (index, row) in rows.enumerated() {
        let record = NSAppleEventDescriptor.record()
        record.setDescriptor(.init(string: row.0), forKeyword: fourCC("ID  "))
        record.setDescriptor(.init(string: row.1), forKeyword: fourCC("pnam"))
        record.setDescriptor(.init(date: row.2), forKeyword: fourCC("ascd"))
        list.insert(record, at: index + 1)
    }
    return list
}

final class FakeAppleEventExecutor: AppleEventExecuting, @unchecked Sendable {
    private let lock = NSLock()
    private let reply: NSAppleEventDescriptor
    private let onOperation: (FixedAppleEventOperation) throws -> Void
    private var storage: [FixedAppleEventOperation] = []

    init(reply: NSAppleEventDescriptor, onOperation: @escaping (FixedAppleEventOperation) throws -> Void = { _ in }) {
        self.reply = reply
        self.onOperation = onOperation
    }

    var operations: [FixedAppleEventOperation] { lock.withLock { storage } }

    func execute(_ operation: FixedAppleEventOperation) throws -> NSAppleEventDescriptor {
        lock.withLock { storage.append(operation) }
        try onOperation(operation)
        return reply
    }
}

private func fourCC(_ value: String) -> UInt32 {
    value.utf8.reduce(0) { ($0 << 8) | UInt32($1) }
}
