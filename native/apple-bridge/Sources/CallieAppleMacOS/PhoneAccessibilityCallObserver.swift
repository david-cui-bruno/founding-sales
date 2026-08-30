import Dispatch
import Foundation
import CallieAppleCore

public protocol BoundedCallObservationScheduling: Sendable {
    func start(_ operation: @escaping @Sendable () -> Void)
    func stop()
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
    private let lock = NSLock()
    private var timer: DispatchSourceTimer?

    public init(interval: TimeInterval = 1, queue: DispatchQueue = DispatchQueue(label: "callie.phone-observation")) {
        self.interval = min(max(interval, 0.25), 60)
        self.queue = queue
    }

    public func start(_ operation: @escaping @Sendable () -> Void) {
        stop()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: interval)
        timer.setEventHandler(handler: operation)
        lock.withLock { self.timer = timer }
        timer.resume()
    }

    public func stop() {
        let existing = lock.withLock { () -> DispatchSourceTimer? in
            let existing = timer
            timer = nil
            return existing
        }
        existing?.setEventHandler {}
        existing?.cancel()
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
}

public enum PhoneCallObservationCapability: Equatable, Sendable {
    case available
    case degraded(PhoneCallObservationDegradation)
}

public enum PhoneCallObservationError: Error, Equatable, Sendable {
    case alreadyStarted
}

public final class PhoneAccessibilityCallObserver<Snapshotter: AXSnapshotting, Scheduler: BoundedCallObservationScheduling, IDGenerator: OpaqueCallIDGenerating>: CallObserving, @unchecked Sendable {
    private let snapshotter: Snapshotter
    private let scheduler: Scheduler
    private let idGenerator: IDGenerator
    private let identitySink: @Sendable (PhoneIdentityEvent) -> Void
    private let capabilitySink: @Sendable (PhoneCallObservationCapability) -> Void
    private let lock = NSLock()
    private var running = false
    private var callSink: (@Sendable (ObservedCall) -> Void)?
    private var currentCall: ObservedCall?
    private var currentIdentity: PhoneIdentitySnapshot?
    private var currentCapability: PhoneCallObservationCapability?

    public init(
        snapshotter: Snapshotter,
        scheduler: Scheduler,
        idGenerator: IDGenerator,
        identitySink: @escaping @Sendable (PhoneIdentityEvent) -> Void,
        capabilitySink: @escaping @Sendable (PhoneCallObservationCapability) -> Void
    ) {
        self.snapshotter = snapshotter
        self.scheduler = scheduler
        self.idGenerator = idGenerator
        self.identitySink = identitySink
        self.capabilitySink = capabilitySink
    }

    public func start(_ sink: @escaping @Sendable (ObservedCall) -> Void) throws {
        let started = lock.withLock { () -> Bool in
            guard !running else { return false }
            running = true
            callSink = sink
            return true
        }
        guard started else { throw PhoneCallObservationError.alreadyStarted }
        scheduler.start { [weak self] in self?.poll() }
    }

    public func stop() {
        lock.withLock {
            running = false
            callSink = nil
            currentCall = nil
            currentIdentity = nil
            currentCapability = nil
        }
        scheduler.stop()
    }

    private func poll() {
        guard lock.withLock({ running }) else { return }
        do {
            apply(PhoneCallSnapshotParser.parse(try snapshotter.snapshot()))
        } catch let error as AXSnapshotError {
            switch error {
            case .accessibilityDenied:
                apply(.degraded(.accessibilityDenied))
            case .phoneApplicationUnavailable:
                apply(.degraded(.phoneUIUnavailable))
            case .inspectionFailed, .elementUnavailable, .actuationFailed:
                apply(.degraded(.snapshotFailed))
            }
        } catch {
            apply(.degraded(.snapshotFailed))
        }
    }

    private func apply(_ parsed: ParsedPhoneCallSnapshot) {
        var calls: [ObservedCall] = []
        var identities: [PhoneIdentityEvent] = []
        var capabilities: [PhoneCallObservationCapability] = []
        var sink: (@Sendable (ObservedCall) -> Void)?

        lock.withLock {
            guard running else { return }
            sink = callSink
            switch parsed {
            case let .active(outgoing, connected, onHold, identity):
                appendCapability(.available, to: &capabilities)
                if var current = currentCall {
                    guard current.outgoing == outgoing, !current.ended else {
                        endCurrentCall(into: &calls)
                        appendCapability(.degraded(.ambiguousPhoneState), to: &capabilities)
                        return
                    }
                    if current.connected && !connected {
                        return
                    }
                    let updated = ObservedCall(id: current.id, outgoing: outgoing, connected: connected, ended: false, onHold: onHold)
                    if updated != current {
                        current = updated
                        currentCall = updated
                        calls.append(updated)
                    }
                    if identity != currentIdentity {
                        currentIdentity = identity
                        identities.append(PhoneIdentityEvent(callID: current.id, identity: identity))
                    }
                } else {
                    let call = ObservedCall(id: idGenerator.nextCallID(), outgoing: outgoing, connected: connected, ended: false, onHold: onHold)
                    currentCall = call
                    currentIdentity = identity
                    calls.append(call)
                    identities.append(PhoneIdentityEvent(callID: call.id, identity: identity))
                }
            case .none:
                endCurrentCall(into: &calls)
                appendCapability(.degraded(.noMacVisibleCall), to: &capabilities)
            case let .degraded(reason):
                endCurrentCall(into: &calls)
                appendCapability(.degraded(reason), to: &capabilities)
            }
        }

        capabilities.forEach(capabilitySink)
        identities.forEach(identitySink)
        calls.forEach { sink?($0) }
    }

    private func endCurrentCall(into calls: inout [ObservedCall]) {
        guard let currentCall else { return }
        calls.append(ObservedCall(
            id: currentCall.id,
            outgoing: currentCall.outgoing,
            connected: currentCall.connected,
            ended: true,
            onHold: currentCall.onHold
        ))
        self.currentCall = nil
        currentIdentity = nil
    }

    private func appendCapability(_ capability: PhoneCallObservationCapability, to capabilities: inout [PhoneCallObservationCapability]) {
        guard capability != currentCapability else { return }
        currentCapability = capability
        capabilities.append(capability)
    }
}

private enum ParsedPhoneCallSnapshot {
    case active(outgoing: Bool, connected: Bool, onHold: Bool, identity: PhoneIdentitySnapshot)
    case none
    case degraded(PhoneCallObservationDegradation)
}

private enum PhoneCallSnapshotParser {
    static func parse(_ snapshot: AXNodeSnapshot) -> ParsedPhoneCallSnapshot {
        guard PhoneAXRules.isSupported(snapshot) else {
            return .degraded(.unsupportedPhoneUIVersion)
        }
        let states = snapshot.allNodes.filter { $0.identifier == "phone.call.state" }
        guard !states.isEmpty else { return .none }
        guard states.count == 1, let state = states[0].value else {
            return .degraded(.ambiguousPhoneState)
        }
        let directions = snapshot.allNodes.filter { $0.identifier == "phone.call.direction" }
        guard directions.count == 1, let direction = directions[0].value else {
            return .degraded(.ambiguousPhoneState)
        }
        let outgoing: Bool
        switch direction {
        case "outgoing": outgoing = true
        case "incoming": outgoing = false
        default: return .degraded(.ambiguousPhoneState)
        }
        let connected: Bool
        let onHold: Bool
        switch state {
        case "connecting": connected = false; onHold = false
        case "connected": connected = true; onHold = false
        case "held": connected = true; onHold = true
        default: return .degraded(.ambiguousPhoneState)
        }

        let identityNodes = snapshot.allNodes.filter { $0.identifier == "phone.call.identity" }
        let identity: PhoneIdentitySnapshot
        if identityNodes.count > 1 {
            identity = .ambiguous
        } else if let value = identityNodes.first?.value, !value.isEmpty {
            identity = .resolved(NormalizedHandle(value))
        } else {
            identity = .unresolved
        }
        return .active(outgoing: outgoing, connected: connected, onHold: onHold, identity: identity)
    }
}
