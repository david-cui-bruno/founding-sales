import CallieAppleProtocol
import Foundation
import Testing
@testable import CallieAppleCore
@testable import CallieAppleMacOS

@Suite("MacOSDependencyContainerTests")
struct MacOSDependencyContainerTests {
    @Test func productionCompositionIsInertUntilTypedCommandAndUses0700Root() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "callie-container-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
        let nonexistentMessages = root.appending(path: "never-opened-chat.db")
        let container = try MacOSDependencyContainer(stagingRoot: root, messagesDatabase: nonexistentMessages)
        let attributes = try FileManager.default.attributesOfItem(atPath: container.stagingRoot.path)
        let permissions = (attributes[.posixPermissions] as? NSNumber)?.intValue

        #expect(permissions == 0o700)
        #expect(container.feasibilityController is MacOSFeasibilityController)
        let hello = try BridgeRequest(
            id: UUID(),
            method: .hello,
            params: .hello(try .init(supportedVersions: [1]))
        )
        let helloResponse = await container.handler.handle(hello)
        #expect(helloResponse.ok)
        #expect(helloResponse.result == [
            "selectedVersion": .number(1),
            "helperVersion": .string("1.0.0"),
        ])
        #expect(!FileManager.default.fileExists(atPath: nonexistentMessages.path))
        #expect(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
    }

    @Test func shutdownCleansOnlyGeneratedContainedEntries() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "callie-container-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
        let container = try MacOSDependencyContainer(stagingRoot: root, messagesDatabase: root.appending(path: "never-opened-chat.db"))
        let generated = root.appending(path: "callie-notes-11111111-1111-4111-8111-111111111111.export")
        let unrelated = root.appending(path: "keep.txt")
        try Data("abandoned synthetic".utf8).write(to: generated)
        try Data("keep".utf8).write(to: unrelated)
        let shutdown = try BridgeRequest(id: UUID(), method: .shutdown, params: .shutdown(.init()))

        let response = await container.handler.handle(shutdown)
        #expect(response.v == 1)
        #expect(response.ok)
        #expect(response.result == ["shuttingDown": .bool(true)])
        #expect(response.error == nil)
        #expect(!FileManager.default.fileExists(atPath: generated.path))
        #expect(FileManager.default.fileExists(atPath: unrelated.path))
    }

    @Test func shutdownCleanupFailureReturnsSanitizedErrorAndNeverClaimsSuccess() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "callie-container-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
        let container = try MacOSDependencyContainer(stagingRoot: root, messagesDatabase: root.appending(path: "never-opened-chat.db"))
        let generatedDirectory = root.appending(path: "callie-notes-export-11111111-1111-4111-8111-111111111111", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: generatedDirectory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let retainedSyntheticPath = generatedDirectory.appending(path: "unexpected-private-sidecar")
        try Data("synthetic retained bytes".utf8).write(to: retainedSyntheticPath)
        let requestID = UUID(uuidString: "77777777-7777-4777-8777-777777777777")!
        let shutdown = try BridgeRequest(id: requestID, method: .shutdown, params: .shutdown(.init()))

        let response = await container.handler.handle(shutdown)

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

    @Test func productionObservationFactoryInjectsOneRelayIntoAllThreeObserverSinks() async throws {
        let emitter = ContainerEventEmitter()
        let observerFactory = CapturingObserverFactory()
        let permissions = ContainerPermissionSource()
        let controller = MacOSDependencyContainer.makeFeasibilityController(
            contacts: permissions,
            accessibility: permissions,
            eventEmitter: emitter,
            callObservationAvailable: true,
            makeObserver: observerFactory.make
        )

        #expect(emitter.events.isEmpty)
        _ = await controller.probeCapabilities()
        #expect(emitter.events.isEmpty)
        #expect(try await controller.startCallObservation())
        observerFactory.emitSyntheticEvidence()

        #expect(emitter.events.map(\.seq) == [0, 1, 2])
        #expect(emitter.events.map(\.event) == [
            .callStateChanged,
            .callIdentityResolved,
            .capabilityChanged,
        ])
        #expect(!String(describing: emitter.events).contains("private@example.invalid"))
        #expect(emitter.events[2].payload == [
            "source": .string("phone_observation"),
            "available": .bool(false),
            "reason": .string("snapshotFailed"),
        ])

        #expect(await controller.stopCallObservation() == false)
        observerFactory.emitSyntheticEvidence()
        #expect(emitter.events.count == 3)
    }
}

private final class ContainerEventEmitter: BridgeEventEmitting, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [BridgeEvent] = []
    var events: [BridgeEvent] { lock.withLock { storage } }
    func emit(_ event: BridgeEvent) -> Bool {
        lock.withLock { storage.append(event) }
        return true
    }
}

private struct ContainerPermissionSource: ContactAuthorizationReading, ContactAccessRequesting, AccessibilityAuthorizationReading, AccessibilityAccessPrompting {
    func currentContactAccess() -> ContactAccess { .notDetermined }
    func requestContactAccess() async throws -> Bool { false }
    func currentAccessibilityAccess() -> AccessibilityAccess { .notDetermined }
    func promptForAccessibility() -> Bool { false }
}

private final class CapturingObserverFactory: @unchecked Sendable {
    private let observer = ContainerCallObserver()
    private var identitySink: (@Sendable (PhoneIdentityEvent) -> Void)?
    private var capabilitySink: (@Sendable (PhoneCallObservationCapability) -> Void)?

    func make(
        identitySink: @escaping @Sendable (PhoneIdentityEvent) -> Void,
        capabilitySink: @escaping @Sendable (PhoneCallObservationCapability) -> Void
    ) -> any CallObserving {
        self.identitySink = identitySink
        self.capabilitySink = capabilitySink
        return observer
    }

    func emitSyntheticEvidence() {
        observer.emit(ObservedCall(id: UUID(), outgoing: true, connected: true, ended: false, onHold: false))
        identitySink?(PhoneIdentityEvent(
            callID: UUID(),
            identity: .resolved(NormalizedHandle("private@example.invalid"))
        ))
        capabilitySink?(.degraded(.snapshotFailed))
    }
}

private final class ContainerCallObserver: CallObserving, @unchecked Sendable {
    private let lock = NSLock()
    private var sink: (@Sendable (ObservedCall) -> Void)?
    func start(_ sink: @escaping @Sendable (ObservedCall) -> Void) throws {
        lock.withLock { self.sink = sink }
    }
    func stop() { lock.withLock { sink = nil } }
    func emit(_ call: ObservedCall) { lock.withLock { sink }?(call) }
}
