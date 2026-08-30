import CallieAppleProtocol
import Foundation
import Testing
@testable import CallieAppleCore

@Suite("FeasibilityControlBridgeTests")
struct FeasibilityControlBridgeTests {
    @Test func fixedControlCommandsReturnExactServiceCompatibleShapes() async throws {
        let controls = FakeAppleFeasibilityController(
            capabilities: CapabilityStatus(
                contacts: .restricted,
                accessibility: .notDetermined,
                callObservationAvailable: true,
                recordingControlAvailable: false
            ),
            requestedAccess: .restricted,
            accessibilityTrusted: false
        )
        let handler = makeControlHandler(controls: controls)

        let capabilityResponse = await handler.handle(try emptyRequest(.probeCapabilities))
        let contactsResponse = await handler.handle(try emptyRequest(.requestContacts))
        let accessibilityResponse = await handler.handle(try emptyRequest(.promptAccessibility))
        let startResponse = await handler.handle(try emptyRequest(.startCallObservation))
        let stopResponse = await handler.handle(try emptyRequest(.stopCallObservation))

        #expect(capabilityResponse.result == [
            "capabilities": .object([
                "contacts": .string("restricted"),
                "accessibility": .string("notDetermined"),
                "callObservationAvailable": .bool(true),
                "recordingControlAvailable": .bool(false),
            ]),
        ])
        #expect(contactsResponse.result == ["access": .string("restricted")])
        #expect(accessibilityResponse.result == ["trusted": .bool(false)])
        #expect(startResponse.result == ["observing": .bool(true)])
        #expect(stopResponse.result == ["observing": .bool(false)])
        #expect(controls.operations == [.probe, .requestContacts, .promptAccessibility, .startObservation, .stopObservation])
    }

    @Test func allPermissionEnumsUseExactPublicSpellings() async throws {
        let cases: [(ContactAccess, AccessibilityAccess, String, String)] = [
            (.full, .granted, "full", "granted"),
            (.limited, .denied, "limited", "denied"),
            (.denied, .notDetermined, "denied", "notDetermined"),
            (.restricted, .denied, "restricted", "denied"),
            (.notDetermined, .notDetermined, "notDetermined", "notDetermined"),
        ]

        for (contacts, accessibility, contactsWire, accessibilityWire) in cases {
            let controls = FakeAppleFeasibilityController(
                capabilities: .init(
                    contacts: contacts,
                    accessibility: accessibility,
                    callObservationAvailable: false,
                    recordingControlAvailable: false
                ),
                requestedAccess: contacts,
                accessibilityTrusted: false
            )
            let handler = makeControlHandler(controls: controls)

            let capabilityResponse = await handler.handle(try emptyRequest(.probeCapabilities))
            let contactsResponse = await handler.handle(try emptyRequest(.requestContacts))

            #expect(capabilityResponse.result == [
                "capabilities": .object([
                    "contacts": .string(contactsWire),
                    "accessibility": .string(accessibilityWire),
                    "callObservationAvailable": .bool(false),
                    "recordingControlAvailable": .bool(false),
                ]),
            ])
            #expect(contactsResponse.result == ["access": .string(contactsWire)])
        }
    }

    @Test func observationStartFailureIsSanitizedAndStopRemainsHarmless() async throws {
        let controls = FakeAppleFeasibilityController()
        controls.startError = .callObservationUnavailable
        let handler = makeControlHandler(controls: controls)

        let start = await handler.handle(try emptyRequest(.startCallObservation))
        let stop = await handler.handle(try emptyRequest(.stopCallObservation))

        #expect(!start.ok)
        #expect(start.result == nil)
        #expect(start.error?.code == .capabilityUnavailable)
        #expect(start.error?.message == "Call observation is unavailable.")
        #expect(start.error?.retryable == false)
        #expect(stop.result == ["observing": .bool(false)])
        #expect(controls.operations == [.startObservation, .stopObservation])
    }

    @Test func permissionRequestFailureUsesConstantNoPayloadDiagnostic() async throws {
        let controls = FakeAppleFeasibilityController()
        controls.requestError = .permissionRequestFailed
        let handler = makeControlHandler(controls: controls)
        let requestID = UUID(uuidString: "88888888-8888-4888-8888-888888888888")!
        let request = try BridgeRequest(
            id: requestID,
            method: .requestContacts,
            params: .requestContacts(.init())
        )

        let response = await handler.handle(request)

        #expect(response.id == requestID)
        #expect(!response.ok)
        #expect(response.result == nil)
        #expect(response.error?.code == .capabilityUnavailable)
        #expect(response.error?.message == "The permission request could not be completed.")
        #expect(response.error?.retryable == false)
        #expect(!String(describing: response.error).contains("CNError"))
        #expect(controls.operations == [.requestContacts])
    }

    @Test func shutdownAlwaysStopsObservationBeforeCleanupAndPreservesCleanupFailure() async throws {
        let log = LockedOperationLog()
        let controls = FakeAppleFeasibilityController(operationSink: log.append)
        let handler = makeControlHandler(controls: controls, shutdown: {
            log.append("cleanup")
            throw BridgeShutdownError.cleanupVerificationFailed
        })
        let requestID = UUID(uuidString: "77777777-7777-4777-8777-777777777777")!
        let request = try BridgeRequest(id: requestID, method: .shutdown, params: .shutdown(.init()))

        let response = await handler.handle(request)

        #expect(log.values == ["stop", "cleanup"])
        #expect(response.v == 1)
        #expect(response.id == requestID)
        #expect(!response.ok)
        #expect(response.result == nil)
        #expect(response.error?.code == .internalError)
        #expect(response.error?.message == "Bridge shutdown cleanup could not be verified.")
        #expect(response.error?.retryable == false)
    }

    private func makeControlHandler(
        controls: FakeAppleFeasibilityController,
        shutdown: @escaping @Sendable () async throws -> Void = {}
    ) -> FeasibilityBridgeCommandHandler {
        let dataPorts = ControlTestDataPorts()
        return FeasibilityBridgeCommandHandler(
            notesScanner: dataPorts,
            notesExporter: dataPorts,
            messageSender: dataPorts,
            messageActivityScanner: dataPorts,
            feasibilityController: controls,
            now: { Date(timeIntervalSince1970: 1_800_000_000) },
            shutdown: shutdown
        )
    }

    private func emptyRequest(_ method: BridgeMethod) throws -> BridgeRequest {
        let params: BridgeRequestParameters = switch method {
        case .probeCapabilities: .probeCapabilities(.init())
        case .requestContacts: .requestContacts(.init())
        case .promptAccessibility: .promptAccessibility(.init())
        case .startCallObservation: .startCallObservation(.init())
        case .stopCallObservation: .stopCallObservation(.init())
        default: fatalError("Test helper accepts fixed feasibility-control methods only")
        }
        return try BridgeRequest(id: UUID(), method: method, params: params)
    }
}

private final class FakeAppleFeasibilityController: AppleFeasibilityControlling, @unchecked Sendable {
    enum Operation: Equatable {
        case probe
        case requestContacts
        case promptAccessibility
        case startObservation
        case stopObservation
    }

    private let lock = NSLock()
    private var storage: [Operation] = []
    private let capabilities: CapabilityStatus
    private let requestedAccess: ContactAccess
    private let accessibilityTrusted: Bool
    private let operationSink: @Sendable (String) -> Void
    var startError: AppleFeasibilityControlError?
    var requestError: AppleFeasibilityControlError?
    var operations: [Operation] { lock.withLock { storage } }

    init(
        capabilities: CapabilityStatus = .init(
            contacts: .notDetermined,
            accessibility: .notDetermined,
            callObservationAvailable: true,
            recordingControlAvailable: false
        ),
        requestedAccess: ContactAccess = .notDetermined,
        accessibilityTrusted: Bool = false,
        operationSink: @escaping @Sendable (String) -> Void = { _ in }
    ) {
        self.capabilities = capabilities
        self.requestedAccess = requestedAccess
        self.accessibilityTrusted = accessibilityTrusted
        self.operationSink = operationSink
    }

    func probeCapabilities() async -> CapabilityStatus {
        append(.probe)
        return capabilities
    }

    func requestContactAccess() async throws -> ContactAccess {
        append(.requestContacts)
        if let requestError { throw requestError }
        return requestedAccess
    }

    func promptForAccessibility() async -> Bool {
        append(.promptAccessibility)
        return accessibilityTrusted
    }

    func startCallObservation() async throws -> Bool {
        append(.startObservation)
        if let startError { throw startError }
        return true
    }

    func stopCallObservation() async -> Bool {
        append(.stopObservation)
        operationSink("stop")
        return false
    }

    private func append(_ operation: Operation) {
        lock.withLock { storage.append(operation) }
    }
}

private final class ControlTestDataPorts: NotesRecordingScanning, NotesAttachmentExporting, MessageTestSending, MessageTestActivityScanning, @unchecked Sendable {
    func scan(since: Date) throws -> NotesRecordingScanResult { .init(artifacts: [], truncated: false) }
    func proveExport(id: NotesArtifactID) throws -> ExportProof {
        .init(artifactID: id, byteCount: 0, sha256: String(repeating: "0", count: 64), plaintextRetained: false)
    }
    func sendTest(_ test: ManualMessageTest) throws -> MessageSendReceipt { .init(commandID: test.commandID) }
    func scanTestActivity(handle: NormalizedHandle, since: Date) throws -> MessageTestActivity {
        .init(sentCount: 0, receivedCount: 0, latestAt: nil)
    }
}

private final class LockedOperationLog: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String] = []
    var values: [String] { lock.withLock { storage } }
    func append(_ value: String) { lock.withLock { storage.append(value) } }
}
