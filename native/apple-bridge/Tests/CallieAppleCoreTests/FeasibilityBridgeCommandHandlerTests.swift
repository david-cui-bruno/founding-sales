import CallieAppleProtocol
import Foundation
import Testing
@testable import CallieAppleCore

@Suite("FeasibilityBridgeCommandHandlerTests")
struct FeasibilityBridgeCommandHandlerTests {
    @Test func initializationAndHandshakeDoNotInvokeFeasibilityPorts() throws {
        let ports = FakeFeasibilityPorts()
        let handler = makeHandler(ports: ports)
        let request = try BridgeRequest(
            id: UUID(),
            method: .hello,
            params: .hello(try HelloRequestParameters(supportedVersions: [1]))
        )

        #expect(handler.handle(request).ok)
        #expect(ports.operations.isEmpty)
    }

    @Test func onlyFixedNotesMethodsDispatchAndReturnNoPath() throws {
        let ports = FakeFeasibilityPorts()
        let handler = makeHandler(ports: ports)
        let scanID = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
        let exportID = UUID(uuidString: "22222222-2222-4222-8222-222222222222")!
        let scan = try BridgeRequest(id: scanID, method: .scanCallRecordings, params: .scanCallRecordings(.init()))
        let export = try BridgeRequest(
            id: exportID,
            method: .exportCallRecording,
            params: .exportCallRecording(.init(artifactId: ports.artifactID.value))
        )

        let scanResponse = handler.handle(scan)
        let exportResponse = handler.handle(export)

        #expect(scanResponse.result == [
            "artifacts": .array([.object([
                "artifactId": .string(ports.artifactID.value.uuidString.lowercased()),
                "createdAt": .string("2027-01-15T08:00:00.000Z"),
            ])]),
            "truncated": .bool(false),
        ])
        #expect(exportResponse.result == [
            "artifactId": .string(ports.artifactID.value.uuidString.lowercased()),
            "byteCount": .number(25),
            "sha256": .string(String(repeating: "a", count: 64)),
            "plaintextRetained": .bool(false),
        ])
        #expect(!String(describing: exportResponse.result).contains("/"))
        #expect(ports.operations == [.scan(fixtureNow.addingTimeInterval(-86_400)), .export(ports.artifactID)])
    }

    @Test func sendUsesExplicitCommandIDAndExactConfirmationWithoutRetry() throws {
        let ports = FakeFeasibilityPorts()
        let handler = makeHandler(ports: ports)
        let commandID = UUID(uuidString: "33333333-3333-4333-8333-333333333333")!
        let request = try BridgeRequest(
            id: UUID(uuidString: "44444444-4444-4444-8444-444444444444")!,
            method: .sendTestMessage,
            params: .sendTestMessage(try .init(
                commandId: commandID,
                recipientHandle: "SYNTHETIC@EXAMPLE.INVALID",
                body: "Synthetic body",
                confirmation: ManualMessageTest.requiredConfirmation
            ))
        )

        let response = handler.handle(request)

        #expect(response.result == ["commandId": .string(commandID.uuidString.lowercased())])
        #expect(ports.operations == [.send(.init(
            commandID: commandID,
            handle: NormalizedHandle("synthetic@example.invalid"),
            body: "Synthetic body",
            confirmation: ManualMessageTest.requiredConfirmation
        ))])
    }

    @Test func failedSendCommandIDIsStillAttemptedAndCannotBeDispatchedAgain() throws {
        let ports = FakeFeasibilityPorts()
        ports.sendError = .sendFailed
        let handler = makeHandler(ports: ports)
        let commandID = UUID()

        #expect(handler.handle(try sendRequest(commandID: commandID)).error?.code == .capabilityUnavailable)
        #expect(handler.handle(try sendRequest(commandID: commandID)).error?.code == .invalidRequest)
        #expect(ports.operations.filter { if case .send = $0 { true } else { false } }.count == 1)
    }

    @Test func attemptedCommandRegistryFailsClosedAtCapacityWithoutEviction() throws {
        let ports = FakeFeasibilityPorts()
        let handler = FeasibilityBridgeCommandHandler(
            notesScanner: ports,
            notesExporter: ports,
            messageSender: ports,
            messageActivityScanner: ports,
            attemptedCommandCapacity: 2,
            now: { fixtureNow }
        )
        let firstID = UUID()
        #expect(handler.handle(try sendRequest(commandID: firstID)).ok)
        #expect(handler.handle(try sendRequest(commandID: UUID())).ok)
        #expect(handler.handle(try sendRequest(commandID: UUID())).error?.code == .capabilityUnavailable)
        #expect(handler.handle(try sendRequest(commandID: firstID)).error?.code == .invalidRequest)
        #expect(ports.operations.filter { if case .send = $0 { true } else { false } }.count == 2)
    }

    @Test func schemaAndConsentFailuresMapToConstantNoPayloadErrors() throws {
        let ports = FakeFeasibilityPorts()
        ports.sendError = .manualConfirmationRequired
        ports.readError = .schemaUnsupported
        let handler = makeHandler(ports: ports)
        let send = try BridgeRequest(
            id: UUID(),
            method: .sendTestMessage,
            params: .sendTestMessage(try .init(
                commandId: UUID(),
                recipientHandle: "private-payload@example.invalid",
                body: "private-payload-body",
                confirmation: ManualMessageTest.requiredConfirmation
            ))
        )
        let scan = try BridgeRequest(
            id: UUID(),
            method: .scanTestMessageActivity,
            params: .scanTestMessageActivity(try .init(recipientHandle: "private-payload@example.invalid"))
        )

        let sendResponse = handler.handle(send)
        let scanResponse = handler.handle(scan)

        #expect(sendResponse.error?.code == .invalidRequest)
        #expect(sendResponse.error?.message == "Exact manual confirmation is required.")
        #expect(scanResponse.error?.code == .schemaUnsupported)
        #expect(scanResponse.error?.message == "The Messages database schema is unsupported.")
        #expect(!String(describing: sendResponse.error).contains("private-payload"))
        #expect(!String(describing: scanResponse.error).contains("private-payload"))
        #expect(ports.operations.count == 2)
    }

    @Test func shutdownInvokesOnlyContainedStagingCleanupHook() throws {
        let ports = FakeFeasibilityPorts()
        let cleanup = LockedCounter()
        let handler = makeHandler(ports: ports, shutdown: { cleanup.increment() })
        let request = try BridgeRequest(id: UUID(), method: .shutdown, params: .shutdown(.init()))

        #expect(handler.handle(request).ok)
        #expect(cleanup.value == 1)
        #expect(ports.operations.isEmpty)
    }

    private func makeHandler(
        ports: FakeFeasibilityPorts,
        shutdown: @escaping @Sendable () -> Void = {}
    ) -> FeasibilityBridgeCommandHandler {
        FeasibilityBridgeCommandHandler(
            notesScanner: ports,
            notesExporter: ports,
            messageSender: ports,
            messageActivityScanner: ports,
            now: { fixtureNow },
            shutdown: shutdown
        )
    }

    private func sendRequest(commandID: UUID) throws -> BridgeRequest {
        try BridgeRequest(
            id: UUID(),
            method: .sendTestMessage,
            params: .sendTestMessage(try .init(
                commandId: commandID,
                recipientHandle: "synthetic@example.invalid",
                body: "Synthetic body",
                confirmation: ManualMessageTest.requiredConfirmation
            ))
        )
    }
}

private let fixtureNow = Date(timeIntervalSince1970: 1_800_000_000)

private final class FakeFeasibilityPorts: NotesRecordingScanning, NotesAttachmentExporting, MessageTestSending, MessageTestActivityScanning, @unchecked Sendable {
    enum Operation: Equatable {
        case scan(Date)
        case export(NotesArtifactID)
        case send(ManualMessageTest)
        case scanMessages(NormalizedHandle, Date)
    }

    let artifactID = NotesArtifactID(UUID(uuidString: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")!)
    private let lock = NSLock()
    private var storage: [Operation] = []
    var sendError: MessagesSendPortError?
    var readError: MessagesReadPortError?
    var operations: [Operation] { lock.withLock { storage } }

    func scan(since: Date) throws -> NotesRecordingScanResult {
        lock.withLock { storage.append(.scan(since)) }
        return .init(artifacts: [.init(id: artifactID, createdAt: fixtureNow)], truncated: false)
    }

    func proveExport(id: NotesArtifactID) throws -> ExportProof {
        lock.withLock { storage.append(.export(id)) }
        return .init(artifactID: id, byteCount: 25, sha256: String(repeating: "a", count: 64), plaintextRetained: false)
    }

    func sendTest(_ test: ManualMessageTest) throws -> MessageSendReceipt {
        lock.withLock { storage.append(.send(test)) }
        if let sendError { throw sendError }
        return .init(commandID: test.commandID)
    }

    func scanTestActivity(handle: NormalizedHandle, since: Date) throws -> MessageTestActivity {
        lock.withLock { storage.append(.scanMessages(handle, since)) }
        if let readError { throw readError }
        return .init(sentCount: 1, receivedCount: 1, latestAt: fixtureNow)
    }
}

private final class LockedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var storage = 0
    var value: Int { lock.withLock { storage } }
    func increment() { lock.withLock { storage += 1 } }
}
