import Dispatch
import Foundation
import CallieAppleCore

public protocol CallObservationCancellation: Sendable {
    func cancel()
}

public protocol BoundedCallObservationScheduling: Sendable {
    func schedule(_ operation: @escaping @Sendable () -> Void) -> any CallObservationCancellation
}

public protocol OpaqueCallIDGenerating: Sendable {
    func nextCallID() -> UUID
}

public struct UUIDCallIDGenerator: OpaqueCallIDGenerating, Sendable {
    public init() {}
    public func nextCallID() -> UUID { UUID() }
}

public final class DispatchBoundedCallObservationScheduler: BoundedCallObservationScheduling, @unchecked Sendable {
    private let interval: TimeInterval
    private let queue: DispatchQueue

    public init(interval: TimeInterval = 1, queue: DispatchQueue = DispatchQueue(label: "callie.phone-observation")) {
        self.interval = min(max(interval, 0.25), 60)
        self.queue = queue
    }

    public func schedule(_ operation: @escaping @Sendable () -> Void) -> any CallObservationCancellation {
        DispatchCallObservationCancellation(interval: interval, queue: queue, operation: operation)
    }
}

private final class DispatchCallObservationCancellation: CallObservationCancellation, @unchecked Sendable {
    private let lock = NSLock()
    private var timer: DispatchSourceTimer?

    init(interval: TimeInterval, queue: DispatchQueue, operation: @escaping @Sendable () -> Void) {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: interval)
        timer.setEventHandler(handler: operation)
        self.timer = timer
        timer.resume()
    }

    func cancel() {
        let timer = lock.withLock { () -> DispatchSourceTimer? in
            let timer = self.timer
            self.timer = nil
            return timer
        }
        timer?.setEventHandler {}
        timer?.cancel()
    }
}

public enum PhoneIdentitySnapshot: Equatable, Sendable {
    case resolved(NormalizedHandle)
    case unresolved
    case ambiguous
}

public struct PhoneIdentityEvent: Equatable, Sendable {
    public let callID: UUID
    public let identity: PhoneIdentitySnapshot

    public init(callID: UUID, identity: PhoneIdentitySnapshot) {
        self.callID = callID
        self.identity = identity
    }
}

public enum PhoneCallObservationDegradation: Equatable, Sendable {
    case accessibilityDenied
    case phoneUIUnavailable
    case unsupportedPhoneUIVersion
    case ambiguousPhoneState
    case noMacVisibleCall
    case snapshotFailed
    case traversalDepthExceeded
    case traversalNodeLimitExceeded
    case traversalCycleDetected
    case traversalDeadlineExceeded
}

public enum PhoneCallObservationCapability: Equatable, Sendable {
    case available
    case degraded(PhoneCallObservationDegradation)
}

public enum PhoneCallObservationError: Error, Equatable, Sendable {
    case alreadyStarted
}

public final class PhoneAccessibilityCallObserver<
    Snapshotter: AXSnapshotting,
    Scheduler: BoundedCallObservationScheduling,
    IDGenerator: OpaqueCallIDGenerating,
    Registry: CurrentPhoneCallRegistering
>: CallObserving, @unchecked Sendable {
    private let snapshotter: Snapshotter
    private let scheduler: Scheduler
    private let idGenerator: IDGenerator
    private let registry: Registry
    private let identitySink: @Sendable (PhoneIdentityEvent) -> Void
    private let capabilitySink: @Sendable (PhoneCallObservationCapability) -> Void
    private let lock = NSLock()
    private let deliveryLock = NSRecursiveLock()
    private var generation: UInt64 = 0
    private var running = false
    private var cancellation: (any CallObservationCancellation)?
    private var callSink: (@Sendable (ObservedCall) -> Void)?
    private var currentCall: ObservedCall?
    private var currentFingerprint: String?
    private var currentIdentity: PhoneIdentitySnapshot?
    private var currentCapability: PhoneCallObservationCapability?

    public init(
        snapshotter: Snapshotter,
        scheduler: Scheduler,
        idGenerator: IDGenerator,
        registry: Registry,
        identitySink: @escaping @Sendable (PhoneIdentityEvent) -> Void,
        capabilitySink: @escaping @Sendable (PhoneCallObservationCapability) -> Void
    ) {
        self.snapshotter = snapshotter
        self.scheduler = scheduler
        self.idGenerator = idGenerator
        self.registry = registry
        self.identitySink = identitySink
        self.capabilitySink = capabilitySink
    }

    public func start(_ sink: @escaping @Sendable (ObservedCall) -> Void) throws {
        let installedGeneration = try lock.withLock { () throws -> UInt64 in
            guard !running else { throw PhoneCallObservationError.alreadyStarted }
            generation &+= 1
            running = true
            callSink = sink
            currentCall = nil
            currentFingerprint = nil
            currentIdentity = nil
            currentCapability = nil
            return generation
        }
        let newCancellation = scheduler.schedule { [weak self] in
            self?.poll(generation: installedGeneration)
        }
        let retained = lock.withLock { () -> Bool in
            guard running, generation == installedGeneration, cancellation == nil else { return false }
            cancellation = newCancellation
            return true
        }
        if !retained { newCancellation.cancel() }
    }

    public func stop() {
        deliveryLock.lock()
        defer { deliveryLock.unlock() }
        let stopped = lock.withLock { () -> (UInt64, (any CallObservationCancellation)?) in
            let stoppedGeneration = generation
            generation &+= 1
            running = false
            callSink = nil
            currentCall = nil
            currentFingerprint = nil
            currentIdentity = nil
            currentCapability = nil
            let cancellation = self.cancellation
            self.cancellation = nil
            return (stoppedGeneration, cancellation)
        }
        registry.clear(observationGeneration: stopped.0)
        stopped.1?.cancel()
    }

    private func poll(generation: UInt64) {
        guard isActive(generation) else { return }
        do {
            apply(PhoneCallSnapshotParser.parse(try snapshotter.snapshot()), generation: generation)
        } catch let error as AXSnapshotError {
            apply(.degraded(Self.degradation(for: error)), generation: generation)
        } catch {
            apply(.degraded(.snapshotFailed), generation: generation)
        }
    }

    private static func degradation(for error: AXSnapshotError) -> PhoneCallObservationDegradation {
        switch error {
        case .accessibilityDenied: .accessibilityDenied
        case .phoneApplicationUnavailable: .phoneUIUnavailable
        case .unsupportedPhoneUIVersion: .unsupportedPhoneUIVersion
        case .maximumDepthExceeded: .traversalDepthExceeded
        case .maximumNodeCountExceeded: .traversalNodeLimitExceeded
        case .cycleDetected: .traversalCycleDetected
        case .deadlineExceeded: .traversalDeadlineExceeded
        case .inspectionFailed, .elementUnavailable, .staleCapture, .liveElementMismatch,
             .containmentMismatch, .actuationFailed: .snapshotFailed
        }
    }

    private func apply(_ parsed: ParsedPhoneCallSnapshot, generation appliedGeneration: UInt64) {
        var calls: [ObservedCall] = []
        var identities: [PhoneIdentityEvent] = []
        var capabilities: [PhoneCallObservationCapability] = []
        var sink: (@Sendable (ObservedCall) -> Void)?

        lock.withLock {
            guard running, generation == appliedGeneration else { return }
            sink = callSink
            switch parsed {
            case let .active(outgoing, connected, onHold, fingerprint, identity):
                appendCapability(.available, to: &capabilities)
                if currentCall != nil, currentFingerprint != fingerprint {
                    endCurrentCall(generation: appliedGeneration, into: &calls)
                }
                if var current = currentCall {
                    guard current.outgoing == outgoing, !current.ended else {
                        endCurrentCall(generation: appliedGeneration, into: &calls)
                        appendCapability(.degraded(.ambiguousPhoneState), to: &capabilities)
                        return
                    }
                    if current.connected && !connected {
                        endCurrentCall(generation: appliedGeneration, into: &calls)
                        appendCapability(.degraded(.ambiguousPhoneState), to: &capabilities)
                        return
                    }
                    let updated = ObservedCall(id: current.id, outgoing: outgoing, connected: connected, ended: false, onHold: onHold)
                    if updated != current {
                        current = updated
                        currentCall = updated
                        calls.append(updated)
                    }
                    registry.replace(PhoneCallAuthorization(call: current, observationGeneration: appliedGeneration, sessionFingerprint: fingerprint))
                    if identity != currentIdentity {
                        currentIdentity = identity
                        identities.append(PhoneIdentityEvent(callID: current.id, identity: identity))
                    }
                } else {
                    let call = ObservedCall(id: idGenerator.nextCallID(), outgoing: outgoing, connected: connected, ended: false, onHold: onHold)
                    currentCall = call
                    currentFingerprint = fingerprint
                    currentIdentity = identity
                    registry.replace(PhoneCallAuthorization(call: call, observationGeneration: appliedGeneration, sessionFingerprint: fingerprint))
                    calls.append(call)
                    identities.append(PhoneIdentityEvent(callID: call.id, identity: identity))
                }
            case .none:
                endCurrentCall(generation: appliedGeneration, into: &calls)
                appendCapability(.degraded(.noMacVisibleCall), to: &capabilities)
            case let .degraded(reason):
                endCurrentCall(generation: appliedGeneration, into: &calls)
                appendCapability(.degraded(reason), to: &capabilities)
            }
        }

        for capability in capabilities {
            guard deliver(generation: appliedGeneration, { capabilitySink(capability) }) else { return }
        }
        for identity in identities {
            guard deliver(generation: appliedGeneration, { identitySink(identity) }) else { return }
        }
        for call in calls {
            guard deliver(generation: appliedGeneration, { sink?(call) }) else { return }
        }
    }

    private func isActive(_ expectedGeneration: UInt64) -> Bool {
        lock.withLock { running && generation == expectedGeneration }
    }

    @discardableResult
    private func deliver(generation expectedGeneration: UInt64, _ callback: () -> Void) -> Bool {
        deliveryLock.lock()
        defer { deliveryLock.unlock() }
        guard isActive(expectedGeneration) else { return false }
        callback()
        return true
    }

    private func endCurrentCall(generation: UInt64, into calls: inout [ObservedCall]) {
        guard let currentCall else {
            registry.clear(observationGeneration: generation)
            currentFingerprint = nil
            currentIdentity = nil
            return
        }
        calls.append(ObservedCall(
            id: currentCall.id,
            outgoing: currentCall.outgoing,
            connected: currentCall.connected,
            ended: true,
            onHold: currentCall.onHold
        ))
        self.currentCall = nil
        currentFingerprint = nil
        currentIdentity = nil
        registry.clear(observationGeneration: generation)
    }

    private func appendCapability(_ capability: PhoneCallObservationCapability, to capabilities: inout [PhoneCallObservationCapability]) {
        guard capability != currentCapability else { return }
        currentCapability = capability
        capabilities.append(capability)
    }
}

private enum ParsedPhoneCallSnapshot {
    case active(outgoing: Bool, connected: Bool, onHold: Bool, fingerprint: String, identity: PhoneIdentitySnapshot)
    case none
    case degraded(PhoneCallObservationDegradation)
}

private enum PhoneCallSnapshotParser {
    static func parse(_ snapshot: AXNodeSnapshot) -> ParsedPhoneCallSnapshot {
        do {
            guard let call = try PhoneAXRules.activeCallWindow(in: snapshot) else { return .none }
            return .active(
                outgoing: call.outgoing,
                connected: call.connected,
                onHold: call.onHold,
                fingerprint: call.sessionFingerprint,
                identity: call.identity
            )
        } catch PhoneAccessibilityError.unsupportedPhoneUIVersion {
            return .degraded(.unsupportedPhoneUIVersion)
        } catch {
            return .degraded(.ambiguousPhoneState)
        }
    }
}
