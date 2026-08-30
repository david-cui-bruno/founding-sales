import Foundation
import Testing
@testable import CallieAppleCore
@testable import CallieAppleMacOS
import CallieAppleProtocol

@Suite("MacOSFeasibilityControllerTests")
struct MacOSFeasibilityControllerTests {
    @Test func constructionAndProbeOnlyReadCurrentStatusesWithoutPromptOrObservation() async {
        let permissions = FakeSystemPermissions(contacts: .restricted, accessibility: .notDetermined)
        let observer = FakeCallObserver()
        let controller = MacOSFeasibilityController(
            contacts: permissions,
            accessibility: permissions,
            observer: observer,
            callObservationAvailable: true
        )

        #expect(permissions.contactReads == 0)
        #expect(permissions.accessibilityReads == 0)
        #expect(permissions.contactRequests == 0)
        #expect(permissions.accessibilityPrompts == 0)
        #expect(observer.startCount == 0)

        let status = await controller.probeCapabilities()

        #expect(status == CapabilityStatus(
            contacts: .restricted,
            accessibility: .notDetermined,
            callObservationAvailable: true,
            recordingControlAvailable: false
        ))
        #expect(permissions.contactReads == 1)
        #expect(permissions.accessibilityReads == 1)
        #expect(permissions.contactRequests == 0)
        #expect(permissions.accessibilityPrompts == 0)
        #expect(observer.startCount == 0)
    }

    @Test func contactsRequestOccursOnlyForExplicitCommandAndReturnsCurrentRestrictedStatus() async throws {
        let permissions = FakeSystemPermissions(contacts: .notDetermined, accessibility: .denied)
        permissions.accessAfterRequest = .restricted
        let observer = FakeCallObserver()
        let controller = MacOSFeasibilityController(
            contacts: permissions,
            accessibility: permissions,
            observer: observer,
            callObservationAvailable: true
        )

        let access = try await controller.requestContactAccess()

        #expect(access == .restricted)
        #expect(permissions.contactRequests == 1)
        #expect(permissions.contactReads == 1)
        #expect(permissions.accessibilityPrompts == 0)
    }

    @Test func deniedContactsRequestReturnsCurrentDeniedStatusWithoutThrowing() async throws {
        let permissions = FakeSystemPermissions(contacts: .notDetermined, accessibility: .denied)
        permissions.accessAfterRequest = .denied
        let controller = MacOSFeasibilityController(
            contacts: permissions,
            accessibility: permissions,
            observer: FakeCallObserver(),
            callObservationAvailable: true
        )

        let access = try await controller.requestContactAccess()

        #expect(access == .denied)
        #expect(permissions.contactRequests == 1)
        #expect(permissions.contactReads == 1)
    }

    @Test func accessibilityPromptOccursOnlyForExplicitCommandAndReturnsTrustResult() async {
        let permissions = FakeSystemPermissions(contacts: .denied, accessibility: .denied)
        permissions.promptResult = true
        let controller = MacOSFeasibilityController(
            contacts: permissions,
            accessibility: permissions,
            observer: FakeCallObserver(),
            callObservationAvailable: true
        )

        let trusted = await controller.promptForAccessibility()

        #expect(trusted)
        #expect(permissions.accessibilityPrompts == 1)
        #expect(permissions.contactRequests == 0)
    }

    @Test func observationStartAndStopAreIdempotentAndNeverClaimRecordingControl() async throws {
        let permissions = FakeSystemPermissions(contacts: .full, accessibility: .granted)
        let observer = FakeCallObserver()
        let controller = MacOSFeasibilityController(
            contacts: permissions,
            accessibility: permissions,
            observer: observer,
            callObservationAvailable: true
        )

        #expect(try await controller.startCallObservation())
        #expect(try await controller.startCallObservation())
        #expect(observer.startCount == 1)
        #expect(await controller.stopCallObservation() == false)
        #expect(await controller.stopCallObservation() == false)
        #expect(observer.stopCount == 1)
        #expect((await controller.probeCapabilities()).recordingControlAvailable == false)
    }

    @Test func failedStartNeverSetsObservingAndLaterStopIsHarmless() async {
        let permissions = FakeSystemPermissions(contacts: .full, accessibility: .granted)
        let observer = FakeCallObserver()
        observer.startError = .alreadyStarted
        let controller = MacOSFeasibilityController(
            contacts: permissions,
            accessibility: permissions,
            observer: observer,
            callObservationAvailable: true
        )

        await #expect(throws: AppleFeasibilityControlError.callObservationUnavailable) {
            try await controller.startCallObservation()
        }
        #expect(await controller.stopCallObservation() == false)
        #expect(observer.startCount == 1)
        #expect(observer.stopCount == 0)
    }

    @Test func unavailableObservationFailsWithoutStartingAdapter() async {
        let observer = FakeCallObserver()
        let controller = MacOSFeasibilityController(
            contacts: FakeSystemPermissions(contacts: .denied, accessibility: .denied),
            accessibility: FakeSystemPermissions(contacts: .denied, accessibility: .denied),
            observer: observer,
            callObservationAvailable: false
        )

        await #expect(throws: AppleFeasibilityControlError.callObservationUnavailable) {
            try await controller.startCallObservation()
        }
        #expect(observer.startCount == 0)
    }

    @Test func successfulStartTransactionFlushesSynchronousCallEvidenceAfterObserverReturns() async throws {
        let emitter = ControllerEventEmitter()
        let relay = PhoneObservationEventRelay(emitter: emitter)
        let observer = FakeCallObserver()
        observer.onStart = { sink in
            sink(ObservedCall(id: UUID(), outgoing: true, connected: true, ended: false, onHold: false))
            #expect(emitter.events.isEmpty)
        }
        let permissions = FakeSystemPermissions(contacts: .full, accessibility: .granted)
        let controller = MacOSFeasibilityController(
            contacts: permissions,
            accessibility: permissions,
            observer: observer,
            callObservationAvailable: true,
            eventRelay: relay
        )

        #expect(try await controller.startCallObservation())

        #expect(emitter.events.count == 1)
        #expect(emitter.events[0].seq == 0)
        #expect(emitter.events[0].event == .callStateChanged)
        #expect(emitter.events[0].payload == [
            "outgoing": .bool(true),
            "connected": .bool(true),
            "ended": .bool(false),
            "onHold": .bool(false),
        ])
    }

    @Test func failedStartTransactionDiscardsSynchronousEvidenceAndLateCallbacks() async {
        let emitter = ControllerEventEmitter()
        let relay = PhoneObservationEventRelay(emitter: emitter)
        let observer = FakeCallObserver()
        observer.onStart = { sink in
            sink(ObservedCall(id: UUID(), outgoing: false, connected: true, ended: false, onHold: false))
        }
        observer.startError = .alreadyStarted
        let permissions = FakeSystemPermissions(contacts: .full, accessibility: .granted)
        let controller = MacOSFeasibilityController(
            contacts: permissions,
            accessibility: permissions,
            observer: observer,
            callObservationAvailable: true,
            eventRelay: relay
        )

        await #expect(throws: AppleFeasibilityControlError.callObservationUnavailable) {
            try await controller.startCallObservation()
        }
        observer.emitLateCall()

        #expect(emitter.events.isEmpty)
        #expect(await controller.stopCallObservation() == false)
    }

    @Test func stopDeactivatesRelayBeforeSyntheticLateObserverCallback() async throws {
        let emitter = ControllerEventEmitter()
        let relay = PhoneObservationEventRelay(emitter: emitter)
        let observer = FakeCallObserver()
        let permissions = FakeSystemPermissions(contacts: .full, accessibility: .granted)
        let controller = MacOSFeasibilityController(
            contacts: permissions,
            accessibility: permissions,
            observer: observer,
            callObservationAvailable: true,
            eventRelay: relay
        )
        #expect(try await controller.startCallObservation())

        #expect(await controller.stopCallObservation() == false)
        observer.emitLateCall()

        #expect(emitter.events.isEmpty)
        #expect(observer.stopCount == 1)
    }
}

private final class FakeSystemPermissions: ContactAuthorizationReading, ContactAccessRequesting, AccessibilityAuthorizationReading, AccessibilityAccessPrompting, @unchecked Sendable {
    private let lock = NSLock()
    private var contacts: ContactAccess
    private let accessibility: AccessibilityAccess
    var accessAfterRequest: ContactAccess?
    var promptResult = false
    private(set) var contactReads = 0
    private(set) var accessibilityReads = 0
    private(set) var contactRequests = 0
    private(set) var accessibilityPrompts = 0

    init(contacts: ContactAccess, accessibility: AccessibilityAccess) {
        self.contacts = contacts
        self.accessibility = accessibility
    }

    func currentContactAccess() -> ContactAccess {
        lock.withLock {
            contactReads += 1
            return contacts
        }
    }

    func requestContactAccess() async throws -> Bool {
        lock.withLock {
            contactRequests += 1
            if let accessAfterRequest { contacts = accessAfterRequest }
            return contacts == .full || contacts == .limited
        }
    }

    func currentAccessibilityAccess() -> AccessibilityAccess {
        lock.withLock {
            accessibilityReads += 1
            return accessibility
        }
    }

    func promptForAccessibility() -> Bool {
        lock.withLock {
            accessibilityPrompts += 1
            return promptResult
        }
    }
}

private final class FakeCallObserver: CallObserving, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var startCount = 0
    private(set) var stopCount = 0
    var startError: PhoneCallObservationError?
    var onStart: (@Sendable (@escaping @Sendable (ObservedCall) -> Void) -> Void)?
    private var capturedSink: (@Sendable (ObservedCall) -> Void)?

    func start(_ sink: @escaping @Sendable (ObservedCall) -> Void) throws {
        try lock.withLock {
            startCount += 1
            capturedSink = sink
            onStart?(sink)
            if let startError { throw startError }
        }
    }

    func stop() {
        lock.withLock { stopCount += 1 }
    }

    func emitLateCall() {
        let sink = lock.withLock { capturedSink }
        sink?(ObservedCall(id: UUID(), outgoing: true, connected: false, ended: true, onHold: false))
    }
}

private final class ControllerEventEmitter: BridgeEventEmitting, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [BridgeEvent] = []
    var events: [BridgeEvent] { lock.withLock { storage } }

    func emit(_ event: BridgeEvent) -> Bool {
        lock.withLock { storage.append(event) }
        return true
    }
}
