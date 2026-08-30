import Foundation
import Testing
@testable import CallieAppleCore
@testable import CallieAppleMacOS

@Suite("NotesAdapterTests")
struct NotesAdapterTests {
    @Test func artifactRegistryFailsClosedAtCapacityWithoutEvictingExistingIDs() throws {
        let registry = NotesArtifactRegistry(capacity: 1)
        let first = try registry.register(scriptingID: "private-a", createdAt: fixtureDate)

        #expect(try registry.register(scriptingID: "private-a", createdAt: fixtureDate) == first)
        #expect(throws: NotesAdapterError.capabilityUnavailable) {
            try registry.register(scriptingID: "private-b", createdAt: fixtureDate)
        }
        #expect(registry.entry(for: first)?.scriptingID == "private-a")
    }

    @Test func emptyScanReplyReturnsNoArtifacts() throws {
        let locator = NotesRecordingLocator(
            executor: FakeAppleEventExecutor(reply: .list()),
            registry: NotesArtifactRegistry()
        )

        let result = try locator.scan(since: fixtureDate)
        #expect(result.artifacts.isEmpty)
        #expect(!result.truncated)
    }

    @Test func scanReturnsOpaqueDeduplicatedAudioArtifactsWithoutTranscriptDependency() throws {
        let executor = FakeAppleEventExecutor(reply: notesReply([
            ("private-attachment-a", "Call Recording.m4a", fixtureDate),
            ("private-attachment-a", "Call Recording.m4a", fixtureDate),
            ("private-attachment-b", "Transcript.txt", fixtureDate),
        ]))
        let registry = NotesArtifactRegistry()
        let locator = NotesRecordingLocator(executor: executor, registry: registry)

        let since = fixtureDate.addingTimeInterval(-1)
        let first = try locator.scan(since: since)
        let second = try locator.scan(since: since)

        #expect(first.artifacts.count == 1)
        #expect(second.artifacts.map(\.id) == first.artifacts.map(\.id))
        #expect(first.artifacts[0].createdAt == fixtureDate)
        #expect(!first.truncated)
        #expect(executor.operations == [.notesScanAttachments(since: since), .notesScanAttachments(since: since)])
    }

    @Test func scanFiltersBeforeCappingAndReportsIncompleteLargeCandidateSet() throws {
        var rows = (0..<501).map { ("old-unrelated-\($0)", "Unrelated.txt", fixtureDate.addingTimeInterval(-100)) }
        rows.append(("recent-audio", "Call Recording.m4a", fixtureDate.addingTimeInterval(1)))
        let locator = NotesRecordingLocator(
            executor: FakeAppleEventExecutor(reply: notesReply(rows)),
            registry: NotesArtifactRegistry()
        )

        let result = try locator.scan(since: fixtureDate)

        #expect(result.artifacts.count == 1)
        #expect(result.artifacts[0].createdAt == fixtureDate.addingTimeInterval(1))
        #expect(result.truncated)
    }

    @Test func fixedDescriptorsUseConstantTargetsAndDataDescriptors() throws {
        let notesScan = try FixedAppleEventDescriptorFactory.descriptor(
            for: .notesScanAttachments(since: fixtureDate)
        )
        let scanProperties = notesScan.paramDescriptor(forKeyword: fourCC("----"))
        let boundedPage = scanProperties?.forKeyword(fourCC("from"))
        #expect(boundedPage?.forKeyword(fourCC("form"))?.enumCodeValue == fourCC("rang"))
        #expect(boundedPage?.forKeyword(fourCC("seld"))?.forKeyword(fourCC("star"))?.int32Value == 1)
        #expect(boundedPage?.forKeyword(fourCC("seld"))?.forKeyword(fourCC("stop"))?.int32Value == 501)
        let sinceQuery = boundedPage?.forKeyword(fourCC("from"))
        #expect(sinceQuery?.forKeyword(fourCC("form"))?.enumCodeValue == fourCC("test"))
        #expect(sinceQuery?.forKeyword(fourCC("seld"))?.forKeyword(fourCC("relo"))?.enumCodeValue == fourCC(">=  "))

        let hostileBody = #"synthetic\"; arbitrary source"#
        let resolution = try FixedAppleEventDescriptorFactory.descriptor(
            for: .messagesResolveParticipants(handle: "synthetic@example.invalid")
        )
        let recipientQuery = resolution.paramDescriptor(forKeyword: fourCC("----"))?.forKeyword(fourCC("from"))
        #expect(recipientQuery?.forKeyword(fourCC("form"))?.enumCodeValue == fourCC("test"))
        let comparison = recipientQuery?.forKeyword(fourCC("seld"))
        let handleProperty = comparison?.forKeyword(fourCC("obj1"))
        #expect(handleProperty?.forKeyword(fourCC("seld"))?.typeCodeValue == fourCC("hndl"))
        #expect(comparison?.forKeyword(fourCC("obj2"))?.stringValue == "synthetic@example.invalid")

        let message = try FixedAppleEventDescriptorFactory.descriptor(
            for: .messagesSend(participantID: "synthetic-participant-id", body: hostileBody)
        )
        #expect(message.eventClass == fourCC("icht"))
        #expect(message.eventID == fourCC("send"))
        #expect(message.paramDescriptor(forKeyword: fourCC("----"))?.stringValue == hostileBody)
        let recipient = message.paramDescriptor(forKeyword: fourCC("TO  "))
        #expect(recipient?.forKeyword(fourCC("form"))?.enumCodeValue == fourCC("ID  "))
        #expect(recipient?.forKeyword(fourCC("seld"))?.stringValue == "synthetic-participant-id")
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
        let id = try registry.register(scriptingID: "private-attachment-a", createdAt: fixtureDate)
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
        let id = try registry.register(scriptingID: "private-attachment-a", createdAt: fixtureDate)
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
        let id = try registry.register(scriptingID: "private-attachment-a", createdAt: fixtureDate)
        let executor = FakeAppleEventExecutor(reply: .null(), onOperation: { operation in
            guard case let .notesSaveAttachment(_, destination) = operation else { return }
            try FileManager.default.createSymbolicLink(at: destination, withDestinationURL: outsideTarget)
            throw AppleEventExecutionError.failed
        })
        let exporter = try NotesAttachmentExporter(executor: executor, registry: registry, stagingRoot: root)

        #expect(throws: NotesAdapterError.plaintextRetentionRisk) { try exporter.proveExport(id: id) }
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

    @Test func cleanupRemovesRegularFileWithGeneratedExportDirectoryName() throws {
        let root = try notesTemporaryDirectory()
        let generated = root.appending(path: "callie-notes-export-11111111-1111-4111-8111-111111111111")
        let unrelated = root.appending(path: "keep.txt")
        try Data("abandoned synthetic".utf8).write(to: generated)
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

    @Test func cleanupUnlinksGeneratedExportDirectorySymlinkWithoutFollowingTarget() throws {
        let root = try notesTemporaryDirectory()
        let outside = try notesTemporaryDirectory().appending(path: "outside-target")
        try Data("outside synthetic".utf8).write(to: outside)
        let generated = root.appending(path: "callie-notes-export-22222222-2222-4222-8222-222222222222")
        try FileManager.default.createSymbolicLink(at: generated, withDestinationURL: outside)
        let exporter = try NotesAttachmentExporter(
            executor: FakeAppleEventExecutor(reply: .null()),
            registry: NotesArtifactRegistry(),
            stagingRoot: root
        )

        try exporter.cleanAbandonedArtifacts()

        #expect((try? FileManager.default.destinationOfSymbolicLink(atPath: generated.path)) == nil)
        #expect(try String(contentsOf: outside, encoding: .utf8) == "outside synthetic")
    }

    @Test func deletionRetriesBeforeReturningSuccessProof() throws {
        let root = try notesTemporaryDirectory()
        let registry = NotesArtifactRegistry()
        let id = try registry.register(scriptingID: "private-attachment-a", createdAt: fixtureDate)
        let deleter = InjectedDescriptorDeleter(failuresBeforeSuccess: 2)
        let executor = FakeAppleEventExecutor(reply: .null(), onOperation: { operation in
            guard case let .notesSaveAttachment(_, destination) = operation else { return }
            try Data("synthetic".utf8).write(to: destination)
        })
        let exporter = try NotesAttachmentExporter(executor: executor, registry: registry, stagingRoot: root, deleter: deleter)

        #expect(try exporter.proveExport(id: id).plaintextRetained == false)
        #expect(deleter.attempts == 3)
        #expect(exporter.retentionRiskSignal == nil)
    }

    @Test func deletionExhaustionReturnsCriticalRiskDisablesExportAndNeverReturnsProof() throws {
        let root = try notesTemporaryDirectory()
        let registry = NotesArtifactRegistry()
        let id = try registry.register(scriptingID: "private-attachment-a", createdAt: fixtureDate)
        let deleter = InjectedDescriptorDeleter(failuresBeforeSuccess: .max)
        let executor = FakeAppleEventExecutor(reply: .null(), onOperation: { operation in
            guard case let .notesSaveAttachment(_, destination) = operation else { return }
            try Data("synthetic".utf8).write(to: destination)
        })
        let exporter = try NotesAttachmentExporter(executor: executor, registry: registry, stagingRoot: root, deleter: deleter)

        #expect(throws: NotesAdapterError.plaintextRetentionRisk) { try exporter.proveExport(id: id) }
        #expect(deleter.attempts == 3)
        #expect(exporter.retentionRiskSignal != nil)
        #expect(throws: NotesAdapterError.plaintextRetentionRisk) { try exporter.proveExport(id: id) }
        #expect(executor.operations.count == 1)
    }

    @Test func unexpectedExportSiblingPreventsProofAndDisablesFurtherExport() throws {
        let root = try notesTemporaryDirectory()
        let registry = NotesArtifactRegistry()
        let id = try registry.register(scriptingID: "private-attachment-a", createdAt: fixtureDate)
        let executor = FakeAppleEventExecutor(reply: .null(), onOperation: { operation in
            guard case let .notesSaveAttachment(_, destination) = operation else { return }
            try Data("synthetic".utf8).write(to: destination)
            try Data("unexpected".utf8).write(to: destination.deletingLastPathComponent().appending(path: "unexpected-sidecar"))
        })
        let exporter = try NotesAttachmentExporter(executor: executor, registry: registry, stagingRoot: root)

        #expect(throws: NotesAdapterError.plaintextRetentionRisk) { try exporter.proveExport(id: id) }
        #expect(exporter.retentionRiskSignal != nil)
        #expect(throws: NotesAdapterError.plaintextRetentionRisk) { try exporter.proveExport(id: id) }
        #expect(executor.operations.count == 1)
    }

    @Test func rootSwapFailsClosedAndNeverCleansReplacementPath() throws {
        let root = try notesTemporaryDirectory()
        let movedRoot = root.deletingLastPathComponent().appending(path: "moved-root-\(UUID().uuidString)")
        let registry = NotesArtifactRegistry()
        let id = try registry.register(scriptingID: "private-attachment-a", createdAt: fixtureDate)
        var replacementFile: URL?
        let executor = FakeAppleEventExecutor(reply: .null(), onOperation: { operation in
            guard case let .notesSaveAttachment(_, destination) = operation else { return }
            try FileManager.default.moveItem(at: root, to: movedRoot)
            try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try Data("outside replacement".utf8).write(to: destination)
            replacementFile = destination
        })
        let exporter = try NotesAttachmentExporter(executor: executor, registry: registry, stagingRoot: root)

        #expect(throws: NotesAdapterError.plaintextRetentionRisk) { try exporter.proveExport(id: id) }
        #expect(replacementFile.map { FileManager.default.fileExists(atPath: $0.path) } == true)
        #expect(exporter.retentionRiskSignal != nil)
    }

    @Test func leafSymlinkSwapFailsClosedWithoutTouchingOutsideTarget() throws {
        let root = try notesTemporaryDirectory()
        let outside = try notesTemporaryDirectory().appending(path: "outside-recording")
        let registry = NotesArtifactRegistry()
        let id = try registry.register(scriptingID: "private-attachment-a", createdAt: fixtureDate)
        let executor = FakeAppleEventExecutor(reply: .null(), onOperation: { operation in
            guard case let .notesSaveAttachment(_, destination) = operation else { return }
            try Data("outside".utf8).write(to: outside)
            try FileManager.default.createSymbolicLink(at: destination, withDestinationURL: outside)
        })
        let exporter = try NotesAttachmentExporter(executor: executor, registry: registry, stagingRoot: root)

        #expect(throws: NotesAdapterError.plaintextRetentionRisk) { try exporter.proveExport(id: id) }
        #expect(try String(contentsOf: outside, encoding: .utf8) == "outside")
    }

    @Test func leafHardLinkSwapFailsClosedWithoutTouchingOutsideTarget() throws {
        let root = try notesTemporaryDirectory()
        let outside = try notesTemporaryDirectory().appending(path: "outside-recording")
        try Data("outside".utf8).write(to: outside)
        let registry = NotesArtifactRegistry()
        let id = try registry.register(scriptingID: "private-attachment-a", createdAt: fixtureDate)
        let executor = FakeAppleEventExecutor(reply: .null(), onOperation: { operation in
            guard case let .notesSaveAttachment(_, destination) = operation else { return }
            try FileManager.default.linkItem(at: outside, to: destination)
        })
        let exporter = try NotesAttachmentExporter(executor: executor, registry: registry, stagingRoot: root)

        #expect(throws: NotesAdapterError.plaintextRetentionRisk) { try exporter.proveExport(id: id) }
        #expect(try String(contentsOf: outside, encoding: .utf8) == "outside")
    }

    @Test func perExportDirectorySwapFailsClosedAndLeavesReplacementUntouched() throws {
        let root = try notesTemporaryDirectory()
        let registry = NotesArtifactRegistry()
        let id = try registry.register(scriptingID: "private-attachment-a", createdAt: fixtureDate)
        var replacementFile: URL?
        let executor = FakeAppleEventExecutor(reply: .null(), onOperation: { operation in
            guard case let .notesSaveAttachment(_, destination) = operation else { return }
            let directory = destination.deletingLastPathComponent()
            let moved = root.appending(path: "moved-original-\(UUID().uuidString)")
            try FileManager.default.moveItem(at: directory, to: moved)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            try Data("replacement".utf8).write(to: destination)
            replacementFile = destination
        })
        let exporter = try NotesAttachmentExporter(executor: executor, registry: registry, stagingRoot: root)

        #expect(throws: NotesAdapterError.plaintextRetentionRisk) { try exporter.proveExport(id: id) }
        #expect(replacementFile.map { FileManager.default.fileExists(atPath: $0.path) } == true)
    }

    @Test func cleanupNeverTouchesOutsideGeneratedName() throws {
        let parent = try notesTemporaryDirectory()
        let root = parent.appending(path: "root", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let outside = parent.appending(path: "callie-notes-11111111-1111-4111-8111-111111111111.export")
        try Data("outside".utf8).write(to: outside)
        let exporter = try NotesAttachmentExporter(executor: FakeAppleEventExecutor(reply: .null()), registry: NotesArtifactRegistry(), stagingRoot: root)

        try exporter.cleanAbandonedArtifacts()

        #expect(try String(contentsOf: outside, encoding: .utf8) == "outside")
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
    private var replies: [NSAppleEventDescriptor]
    private let onOperation: (FixedAppleEventOperation) throws -> Void
    private var storage: [FixedAppleEventOperation] = []

    init(reply: NSAppleEventDescriptor, onOperation: @escaping (FixedAppleEventOperation) throws -> Void = { _ in }) {
        replies = [reply]
        self.onOperation = onOperation
    }

    init(replies: [NSAppleEventDescriptor], onOperation: @escaping (FixedAppleEventOperation) throws -> Void = { _ in }) {
        self.replies = replies
        self.onOperation = onOperation
    }

    var operations: [FixedAppleEventOperation] { lock.withLock { storage } }

    func execute(_ operation: FixedAppleEventOperation) throws -> NSAppleEventDescriptor {
        lock.withLock { storage.append(operation) }
        try onOperation(operation)
        return lock.withLock { replies.count > 1 ? replies.removeFirst() : replies[0] }
    }
}

private func fourCC(_ value: String) -> UInt32 {
    value.utf8.reduce(0) { ($0 << 8) | UInt32($1) }
}

private final class InjectedDescriptorDeleter: DescriptorRelativeDeleting, @unchecked Sendable {
    private let lock = NSLock()
    private var failuresRemaining: Int
    private var attemptStorage = 0
    private let real = POSIXDescriptorDeleter()
    var attempts: Int { lock.withLock { attemptStorage } }

    init(failuresBeforeSuccess: Int) { failuresRemaining = failuresBeforeSuccess }

    func unlinkFile(named name: String, in directoryFD: Int32) throws {
        let fail = lock.withLock { () -> Bool in
            attemptStorage += 1
            if failuresRemaining > 0 { failuresRemaining -= 1; return true }
            return false
        }
        if fail { throw DescriptorRelativeDeleteError.failed }
        try real.unlinkFile(named: name, in: directoryFD)
    }

    func isAbsent(named name: String, in directoryFD: Int32) throws -> Bool {
        try real.isAbsent(named: name, in: directoryFD)
    }
}
