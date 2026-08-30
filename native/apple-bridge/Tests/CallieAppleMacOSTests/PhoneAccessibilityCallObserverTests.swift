import Dispatch
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
        let registry = LockedCurrentPhoneCallRegistry()
        let log = PhoneObservationLog()
        let observer = PhoneAccessibilityCallObserver(
            snapshotter: SequenceSnapshotter([active, active, none]),
            scheduler: scheduler,
            idGenerator: FixedIDGenerator([firstCallID]),
            registry: registry,
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
        #expect(log.identities == [PhoneIdentityEvent(callID: firstCallID, identity: .unresolved)])
        #expect(log.capabilities == [.available, .degraded(.noMacVisibleCall)])
    }

    @Test func unresolvedIncomingCallKeepsIdentitySeparateFromObservedCall() throws {
        let incoming = try FixtureSupport.snapshot(named: "phone-call-connected-unresolved-incoming")
        let scheduler = ManualScheduler()
        let registry = LockedCurrentPhoneCallRegistry()
        let log = PhoneObservationLog()
        let observer = PhoneAccessibilityCallObserver(
            snapshotter: SequenceSnapshotter([incoming]),
            scheduler: scheduler,
            idGenerator: FixedIDGenerator([firstCallID]),
            registry: registry,
            identitySink: log.appendIdentity,
            capabilitySink: log.appendCapability
        )
        try observer.start(log.appendCall)

        scheduler.tick()

        #expect(log.calls == [ObservedCall(id: firstCallID, outgoing: false, connected: true, ended: false, onHold: false)])
        #expect(log.identities == [PhoneIdentityEvent(callID: firstCallID, identity: .unresolved)])
        #expect(log.deliveryOrder == ["capability", "identity", "call"])
    }

    @Test func incomingIdentityAcceptsStrictEmailButLocalizedNameRemainsUnresolved() throws {
        let validEmail = try FixtureSupport.snapshot(named: "phone-call-connected-valid-incoming")
        let localizedName = try FixtureSupport.snapshot(named: "phone-call-connected-unresolved-incoming")
        let scheduler = ManualScheduler()
        let registry = LockedCurrentPhoneCallRegistry()
        let log = PhoneObservationLog()
        let observer = PhoneAccessibilityCallObserver(
            snapshotter: SequenceSnapshotter([validEmail, localizedName]),
            scheduler: scheduler,
            idGenerator: FixedIDGenerator([firstCallID, secondCallID]),
            registry: registry,
            identitySink: log.appendIdentity,
            capabilitySink: log.appendCapability
        )
        try observer.start(log.appendCall)

        scheduler.tick()
        scheduler.tick()

        #expect(log.identities == [
            PhoneIdentityEvent(callID: firstCallID, identity: .resolved(NormalizedHandle("Founder@Example.COM"))),
            PhoneIdentityEvent(callID: secondCallID, identity: .unresolved),
        ])
        #expect(log.calls.map(\.id) == [firstCallID, firstCallID, secondCallID])
    }

    @Test func changedFingerprintReplacesSameDirectionCallWithoutIntermediateNoCall() throws {
        let first = try FixtureSupport.snapshot(named: "phone-call-connected-known-outgoing")
        let replacement = try FixtureSupport.snapshot(named: "phone-call-connected-replacement-outgoing")
        let scheduler = ManualScheduler()
        let registry = LockedCurrentPhoneCallRegistry()
        let log = PhoneObservationLog()
        let observer = PhoneAccessibilityCallObserver(
            snapshotter: SequenceSnapshotter([first, replacement]),
            scheduler: scheduler,
            idGenerator: FixedIDGenerator([firstCallID, secondCallID]),
            registry: registry,
            identitySink: log.appendIdentity,
            capabilitySink: log.appendCapability
        )
        try observer.start(log.appendCall)

        scheduler.tick()
        scheduler.tick()

        #expect(log.calls == [
            ObservedCall(id: firstCallID, outgoing: true, connected: true, ended: false, onHold: false),
            ObservedCall(id: firstCallID, outgoing: true, connected: true, ended: true, onHold: false),
            ObservedCall(id: secondCallID, outgoing: true, connected: true, ended: false, onHold: false),
        ])
        #expect(registry.currentAuthorization()?.call.id == secondCallID)
        #expect(registry.currentAuthorization()?.sessionFingerprint == "session-b-0001")
    }

    @Test func connectedCallRegressingToDisconnectedStateEndsAndRevokesRegistry() throws {
        let connected = try FixtureSupport.snapshot(named: "phone-call-connected-known-outgoing")
        let disconnected = try FixtureSupport.snapshot(named: "phone-call-connecting-same-session")
        let scheduler = ManualScheduler()
        let registry = LockedCurrentPhoneCallRegistry()
        let log = PhoneObservationLog()
        let observer = PhoneAccessibilityCallObserver(
            snapshotter: SequenceSnapshotter([connected, disconnected]),
            scheduler: scheduler,
            idGenerator: FixedIDGenerator([firstCallID]),
            registry: registry,
            identitySink: log.appendIdentity,
            capabilitySink: log.appendCapability
        )
        try observer.start(log.appendCall)

        scheduler.tick()
        scheduler.tick()

        #expect(log.calls.map(\.ended) == [false, true])
        #expect(registry.currentAuthorization() == nil)
    }

    @Test func absentAndAmbiguousPhoneStateNeverSynthesizesARecordableCall() throws {
        let none = try FixtureSupport.snapshot(named: "phone-call-no-active")
        let ambiguous = try FixtureSupport.snapshot(named: "phone-call-ambiguous")
        let scheduler = ManualScheduler()
        let registry = LockedCurrentPhoneCallRegistry()
        let log = PhoneObservationLog()
        let observer = PhoneAccessibilityCallObserver(
            snapshotter: SequenceSnapshotter([none, ambiguous]),
            scheduler: scheduler,
            idGenerator: FixedIDGenerator([firstCallID]),
            registry: registry,
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

    @Test func missingFingerprintAndMatchingStateOutsideCallWindowNeverCreateCall() throws {
        let missingFingerprint = try FixtureSupport.snapshot(named: "phone-call-fingerprint-missing")
        let outsideWindow = try FixtureSupport.snapshot(named: "phone-call-state-outside-window")
        let scheduler = ManualScheduler()
        let registry = LockedCurrentPhoneCallRegistry()
        let log = PhoneObservationLog()
        let observer = PhoneAccessibilityCallObserver(
            snapshotter: SequenceSnapshotter([missingFingerprint, outsideWindow]),
            scheduler: scheduler,
            idGenerator: FixedIDGenerator([firstCallID]),
            registry: registry,
            identitySink: log.appendIdentity,
            capabilitySink: log.appendCapability
        )
        try observer.start(log.appendCall)

        scheduler.tick()
        scheduler.tick()

        #expect(log.calls.isEmpty)
        #expect(log.identities.isEmpty)
        #expect(log.capabilities == [.degraded(.ambiguousPhoneState), .degraded(.noMacVisibleCall)])
        #expect(registry.currentAuthorization() == nil)
    }

    @Test func endedSessionFollowedByNewVisibleCallUsesANewOpaqueID() throws {
        let active = try FixtureSupport.snapshot(named: "phone-call-connected-known-outgoing")
        let none = try FixtureSupport.snapshot(named: "phone-call-no-active")
        let scheduler = ManualScheduler()
        let registry = LockedCurrentPhoneCallRegistry()
        let log = PhoneObservationLog()
        let observer = PhoneAccessibilityCallObserver(
            snapshotter: SequenceSnapshotter([active, none, active]),
            scheduler: scheduler,
            idGenerator: FixedIDGenerator([firstCallID, secondCallID]),
            registry: registry,
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
        let registry = LockedCurrentPhoneCallRegistry()
        let log = PhoneObservationLog()
        let snapshotter = SequenceSnapshotter([active])
        let observer = PhoneAccessibilityCallObserver(
            snapshotter: snapshotter,
            scheduler: scheduler,
            idGenerator: FixedIDGenerator([firstCallID]),
            registry: registry,
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
        let registry = LockedCurrentPhoneCallRegistry()
        let log = PhoneObservationLog()
        let observer = PhoneAccessibilityCallObserver(
            snapshotter: SequenceSnapshotter(results: [.failure(AXSnapshotError.accessibilityDenied)]),
            scheduler: scheduler,
            idGenerator: FixedIDGenerator([firstCallID]),
            registry: registry,
            identitySink: log.appendIdentity,
            capabilitySink: log.appendCapability
        )
        try observer.start(log.appendCall)

        scheduler.tick()

        #expect(log.calls.isEmpty)
        #expect(log.capabilities == [.degraded(.accessibilityDenied)])
    }

    @Test func stopDuringSchedulerInstallationCancelsOnlyThatInstallationAndEmitsNothing() throws {
        let active = try FixtureSupport.snapshot(named: "phone-call-connected-known-outgoing")
        let scheduler = ManualScheduler()
        let registry = LockedCurrentPhoneCallRegistry()
        let log = PhoneObservationLog()
        let stopAction = LockedAction()
        scheduler.onSchedule = stopAction.run
        let observer = PhoneAccessibilityCallObserver(
            snapshotter: SequenceSnapshotter([active]),
            scheduler: scheduler,
            idGenerator: FixedIDGenerator([firstCallID]),
            registry: registry,
            identitySink: log.appendIdentity,
            capabilitySink: log.appendCapability
        )
        stopAction.action = observer.stop

        try observer.start(log.appendCall)
        scheduler.tick(index: 0)

        #expect(scheduler.isCancelled(index: 0))
        #expect(log.deliveryOrder.isEmpty)
        #expect(registry.currentAuthorization() == nil)
    }

    @Test func stopFromCapabilityCallbackSuppressesIdentityAndCallCallbacks() throws {
        let active = try FixtureSupport.snapshot(named: "phone-call-connected-known-outgoing")
        let scheduler = ManualScheduler()
        let registry = LockedCurrentPhoneCallRegistry()
        let log = PhoneObservationLog()
        let stopAction = LockedAction()
        let observer = PhoneAccessibilityCallObserver(
            snapshotter: SequenceSnapshotter([active]),
            scheduler: scheduler,
            idGenerator: FixedIDGenerator([firstCallID]),
            registry: registry,
            identitySink: log.appendIdentity,
            capabilitySink: { capability in
                log.appendCapability(capability)
                stopAction.run()
            }
        )
        stopAction.action = observer.stop
        try observer.start(log.appendCall)

        scheduler.tick()

        #expect(log.capabilities == [.available])
        #expect(log.identities.isEmpty)
        #expect(log.calls.isEmpty)
        #expect(registry.currentAuthorization() == nil)
    }

    @Test func oldPollCompletionAfterStopAndRestartCannotMutateNewGeneration() async throws {
        let old = try FixtureSupport.snapshot(named: "phone-call-connected-known-outgoing")
        let replacement = try FixtureSupport.snapshot(named: "phone-call-connected-replacement-outgoing")
        let snapshotter = GatedFirstSnapshotter(first: old, later: replacement)
        let scheduler = ManualScheduler()
        let registry = LockedCurrentPhoneCallRegistry()
        let log = PhoneObservationLog()
        let observer = PhoneAccessibilityCallObserver(
            snapshotter: snapshotter,
            scheduler: scheduler,
            idGenerator: FixedIDGenerator([firstCallID]),
            registry: registry,
            identitySink: log.appendIdentity,
            capabilitySink: log.appendCapability
        )
        try observer.start(log.appendCall)
        let oldPoll = Task.detached { scheduler.tick(index: 0) }
        snapshotter.waitUntilFirstCaptureBegins()

        observer.stop()
        try observer.start(log.appendCall)
        snapshotter.releaseFirstCapture()
        await oldPoll.value

        #expect(log.deliveryOrder.isEmpty)
        #expect(registry.currentAuthorization() == nil)

        scheduler.tick(index: 1)
        #expect(log.calls == [ObservedCall(id: firstCallID, outgoing: true, connected: true, ended: false, onHold: false)])
        #expect(registry.currentAuthorization()?.sessionFingerprint == "session-b-0001")
    }
}

private final class ManualScheduler: BoundedCallObservationScheduling, @unchecked Sendable {
    private let lock = NSLock()
    private var handles: [ManualCancellation] = []
    var onSchedule: (@Sendable () -> Void)?
    var isStopped: Bool { lock.withLock { handles.last?.isCancelled ?? true } }

    func schedule(_ operation: @escaping @Sendable () -> Void) -> any CallObservationCancellation {
        let handle = ManualCancellation(operation: operation)
        lock.withLock { handles.append(handle) }
        onSchedule?()
        return handle
    }

    func tick() {
        lock.withLock { handles.last }?.fire()
    }

    func tick(index: Int) {
        lock.withLock { handles[index] }.fire()
    }

    func isCancelled(index: Int) -> Bool {
        lock.withLock { handles[index] }.isCancelled
    }
}

private final class ManualCancellation: CallObservationCancellation, @unchecked Sendable {
    private let lock = NSLock()
    private var operation: (@Sendable () -> Void)?
    init(operation: @escaping @Sendable () -> Void) { self.operation = operation }
    var isCancelled: Bool { lock.withLock { operation == nil } }
    func cancel() { lock.withLock { operation = nil } }
    func fire() { lock.withLock { operation }?() }
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

private final class LockedAction: @unchecked Sendable {
    private let lock = NSLock()
    var action: (@Sendable () -> Void)? {
        get { lock.withLock { storage } }
        set { lock.withLock { storage = newValue } }
    }
    private var storage: (@Sendable () -> Void)?
    func run() { action?() }
}

private final class GatedFirstSnapshotter: AXSnapshotting, @unchecked Sendable {
    private let lock = NSLock()
    private let began = DispatchSemaphore(value: 0)
    private let release = DispatchSemaphore(value: 0)
    private let first: AXNodeSnapshot
    private let later: AXNodeSnapshot
    private var count = 0

    init(first: AXNodeSnapshot, later: AXNodeSnapshot) {
        self.first = first
        self.later = later
    }

    func snapshot() throws -> AXNodeSnapshot {
        let index = lock.withLock { () -> Int in
            defer { count += 1 }
            return count
        }
        guard index == 0 else { return later }
        began.signal()
        release.wait()
        return first
    }

    func waitUntilFirstCaptureBegins() { began.wait() }
    func releaseFirstCapture() { release.signal() }
}

private let firstCallID = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
private let secondCallID = UUID(uuidString: "22222222-2222-4222-8222-222222222222")!
