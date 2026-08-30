import Foundation
import Testing
@testable import CallieAppleCore
@testable import CallieAppleMacOS

@Suite("PhoneAccessibilityCallObserverTests")
struct PhoneAccessibilityCallObserverTests {
    @Test func connectedDuplicateThenNoActiveCallEmitsOneSessionAndMonotonicEnd() throws {
        let active = try FixtureSupport.snapshot(named: "phone-call-connected-known-outgoing")
        let none = try FixtureSupport.snapshot(named: "phone-call-no-active")
        let scheduler = ManualScheduler()
        let log = PhoneObservationLog()
        let observer = PhoneAccessibilityCallObserver(
            snapshotter: SequenceSnapshotter([active, active, none]),
            scheduler: scheduler,
            idGenerator: FixedIDGenerator([firstCallID]),
            identitySink: log.appendIdentity,
            capabilitySink: log.appendCapability
        )
        try observer.start(log.appendCall)

        scheduler.tick()
        scheduler.tick()
        scheduler.tick()

        #expect(log.calls == [
            ObservedCall(id: firstCallID, outgoing: true, connected: true, ended: false, onHold: false),
            ObservedCall(id: firstCallID, outgoing: true, connected: true, ended: true, onHold: false),
        ])
        #expect(log.identities == [PhoneIdentityEvent(callID: firstCallID, identity: .resolved(NormalizedHandle("synthetic-known-outgoing")))])
        #expect(log.capabilities == [.available, .degraded(.noMacVisibleCall)])
    }

    @Test func unresolvedIncomingCallKeepsIdentitySeparateFromObservedCall() throws {
        let incoming = try FixtureSupport.snapshot(named: "phone-call-connected-unresolved-incoming")
        let scheduler = ManualScheduler()
        let log = PhoneObservationLog()
        let observer = PhoneAccessibilityCallObserver(
            snapshotter: SequenceSnapshotter([incoming]),
            scheduler: scheduler,
            idGenerator: FixedIDGenerator([firstCallID]),
            identitySink: log.appendIdentity,
            capabilitySink: log.appendCapability
        )
        try observer.start(log.appendCall)

        scheduler.tick()

        #expect(log.calls == [ObservedCall(id: firstCallID, outgoing: false, connected: true, ended: false, onHold: false)])
        #expect(log.identities == [PhoneIdentityEvent(callID: firstCallID, identity: .unresolved)])
        #expect(log.deliveryOrder == ["capability", "identity", "call"])
    }

    @Test func absentAndAmbiguousPhoneStateNeverSynthesizesARecordableCall() throws {
        let none = try FixtureSupport.snapshot(named: "phone-call-no-active")
        let ambiguous = try FixtureSupport.snapshot(named: "phone-call-ambiguous")
        let scheduler = ManualScheduler()
        let log = PhoneObservationLog()
        let observer = PhoneAccessibilityCallObserver(
            snapshotter: SequenceSnapshotter([none, ambiguous]),
            scheduler: scheduler,
            idGenerator: FixedIDGenerator([firstCallID]),
            identitySink: log.appendIdentity,
            capabilitySink: log.appendCapability
        )
        try observer.start(log.appendCall)

        scheduler.tick()
        scheduler.tick()

        #expect(log.calls.isEmpty)
        #expect(log.identities.isEmpty)
        #expect(log.capabilities == [.degraded(.noMacVisibleCall), .degraded(.ambiguousPhoneState)])
    }

    @Test func endedSessionFollowedByNewVisibleCallUsesANewOpaqueID() throws {
        let active = try FixtureSupport.snapshot(named: "phone-call-connected-known-outgoing")
        let none = try FixtureSupport.snapshot(named: "phone-call-no-active")
        let scheduler = ManualScheduler()
        let log = PhoneObservationLog()
        let observer = PhoneAccessibilityCallObserver(
            snapshotter: SequenceSnapshotter([active, none, active]),
            scheduler: scheduler,
            idGenerator: FixedIDGenerator([firstCallID, secondCallID]),
            identitySink: log.appendIdentity,
            capabilitySink: log.appendCapability
        )
        try observer.start(log.appendCall)

        scheduler.tick()
        scheduler.tick()
        scheduler.tick()

        #expect(log.calls.map(\.id) == [firstCallID, firstCallID, secondCallID])
        #expect(log.calls.map(\.ended) == [false, true, false])
    }

    @Test func stopCancelsSchedulerAndPreventsFurtherSnapshotsOrEvents() throws {
        let active = try FixtureSupport.snapshot(named: "phone-call-connected-known-outgoing")
        let scheduler = ManualScheduler()
        let log = PhoneObservationLog()
        let snapshotter = SequenceSnapshotter([active])
        let observer = PhoneAccessibilityCallObserver(
            snapshotter: snapshotter,
            scheduler: scheduler,
            idGenerator: FixedIDGenerator([firstCallID]),
            identitySink: log.appendIdentity,
            capabilitySink: log.appendCapability
        )
        try observer.start(log.appendCall)
        observer.stop()

        scheduler.tick()

        #expect(scheduler.isStopped)
        #expect(log.calls.isEmpty)
        #expect(log.identities.isEmpty)
        #expect(log.capabilities.isEmpty)
    }

    @Test func accessibilityFailureReportsDegradedAndDoesNotSynthesizeCall() throws {
        let scheduler = ManualScheduler()
        let log = PhoneObservationLog()
        let observer = PhoneAccessibilityCallObserver(
            snapshotter: SequenceSnapshotter(results: [.failure(AXSnapshotError.accessibilityDenied)]),
            scheduler: scheduler,
            idGenerator: FixedIDGenerator([firstCallID]),
            identitySink: log.appendIdentity,
            capabilitySink: log.appendCapability
        )
        try observer.start(log.appendCall)

        scheduler.tick()

        #expect(log.calls.isEmpty)
        #expect(log.capabilities == [.degraded(.accessibilityDenied)])
    }
}

private final class ManualScheduler: BoundedCallObservationScheduling, @unchecked Sendable {
    private let lock = NSLock()
    private var operation: (@Sendable () -> Void)?
    private(set) var isStopped = false

    func start(_ operation: @escaping @Sendable () -> Void) {
        lock.withLock {
            isStopped = false
            self.operation = operation
        }
    }

    func stop() {
        lock.withLock {
            isStopped = true
            operation = nil
        }
    }

    func tick() {
        let current = lock.withLock { operation }
        current?()
    }
}

private final class FixedIDGenerator: OpaqueCallIDGenerating, @unchecked Sendable {
    private let lock = NSLock()
    private var ids: [UUID]

    init(_ ids: [UUID]) { self.ids = ids }

    func nextCallID() -> UUID {
        lock.withLock { ids.removeFirst() }
    }
}

private final class PhoneObservationLog: @unchecked Sendable {
    private let lock = NSLock()
    private var callStorage: [ObservedCall] = []
    private var identityStorage: [PhoneIdentityEvent] = []
    private var capabilityStorage: [PhoneCallObservationCapability] = []
    private var deliveryOrderStorage: [String] = []

    var calls: [ObservedCall] { lock.withLock { callStorage } }
    var identities: [PhoneIdentityEvent] { lock.withLock { identityStorage } }
    var capabilities: [PhoneCallObservationCapability] { lock.withLock { capabilityStorage } }
    var deliveryOrder: [String] { lock.withLock { deliveryOrderStorage } }

    func appendCall(_ call: ObservedCall) { lock.withLock { callStorage.append(call); deliveryOrderStorage.append("call") } }
    func appendIdentity(_ event: PhoneIdentityEvent) { lock.withLock { identityStorage.append(event); deliveryOrderStorage.append("identity") } }
    func appendCapability(_ capability: PhoneCallObservationCapability) { lock.withLock { capabilityStorage.append(capability); deliveryOrderStorage.append("capability") } }
}

private let firstCallID = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
private let secondCallID = UUID(uuidString: "22222222-2222-4222-8222-222222222222")!
