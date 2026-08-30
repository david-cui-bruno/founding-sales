import CallieAppleCore
import CallieAppleProtocol
import Foundation

public protocol PhoneObservationEventRelaying: Sendable {
    func beginObservationStart()
    func commitObservationStart() -> Bool
    func cancelObservationStart()
    func deactivate()
    func receive(_ call: ObservedCall)
}

public final class PhoneObservationEventRelay: PhoneObservationEventRelaying, @unchecked Sendable {
    private enum State {
        case inactive
        case starting([PendingEvent])
        case active
    }

    private struct PendingEvent {
        let name: BridgeEventName
        let payload: [String: JSONValue]
    }

    private static let maximumBufferedEvents = 128
    private let emitter: any BridgeEventEmitting
    private let lock = NSLock()
    private var state: State = .inactive
    private var nextSequence = 0
    private var bufferOverflowed = false

    public init(emitter: any BridgeEventEmitting) {
        self.emitter = emitter
    }

    public func beginObservationStart() {
        lock.withLock {
            state = .starting([])
            bufferOverflowed = false
        }
    }

    public func commitObservationStart() -> Bool {
        lock.withLock {
            guard case let .starting(buffered) = state, !bufferOverflowed else {
                state = .inactive
                bufferOverflowed = false
                return false
            }
            state = .active
            for event in buffered { emit(event) }
            return true
        }
    }

    public func cancelObservationStart() {
        lock.withLock {
            state = .inactive
            bufferOverflowed = false
        }
    }

    public func deactivate() {
        cancelObservationStart()
    }

    public func receive(_ call: ObservedCall) {
        accept(PendingEvent(name: .callStateChanged, payload: [
            "outgoing": .bool(call.outgoing),
            "connected": .bool(call.connected),
            "ended": .bool(call.ended),
            "onHold": .bool(call.onHold),
        ]))
    }

    public func receive(_ identity: PhoneIdentityEvent) {
        switch identity.identity {
        case .resolved:
            accept(PendingEvent(name: .callIdentityResolved, payload: [
                "identity": .string("resolved"),
            ]))
        case .unresolved:
            accept(PendingEvent(name: .callIdentityUnresolved, payload: [
                "identity": .string("unresolved"),
            ]))
        case .ambiguous:
            accept(PendingEvent(name: .callIdentityUnresolved, payload: [
                "identity": .string("ambiguous"),
            ]))
        }
    }

    public func receive(_ capability: PhoneCallObservationCapability) {
        switch capability {
        case .available:
            accept(PendingEvent(name: .capabilityChanged, payload: [
                "source": .string("phone_observation"),
                "available": .bool(true),
            ]))
        case let .degraded(reason):
            accept(PendingEvent(name: .capabilityChanged, payload: [
                "source": .string("phone_observation"),
                "available": .bool(false),
                "reason": .string(Self.wireValue(reason)),
            ]))
        }
    }

    private func accept(_ event: PendingEvent) {
        lock.withLock {
            switch state {
            case .inactive:
                return
            case var .starting(buffered):
                guard buffered.count < Self.maximumBufferedEvents else {
                    bufferOverflowed = true
                    return
                }
                buffered.append(event)
                state = .starting(buffered)
            case .active:
                emit(event)
            }
        }
    }

    private func emit(_ pending: PendingEvent) {
        guard let event = try? BridgeEvent(seq: nextSequence, event: pending.name, payload: pending.payload) else {
            return
        }
        if emitter.emit(event) { nextSequence += 1 }
    }

    private static func wireValue(_ reason: PhoneCallObservationDegradation) -> String {
        switch reason {
        case .accessibilityDenied: "accessibilityDenied"
        case .phoneUIUnavailable: "phoneUIUnavailable"
        case .unsupportedPhoneUIVersion: "unsupportedPhoneUIVersion"
        case .ambiguousPhoneState: "ambiguousPhoneState"
        case .noMacVisibleCall: "noMacVisibleCall"
        case .snapshotFailed: "snapshotFailed"
        case .traversalDepthExceeded: "traversalDepthExceeded"
        case .traversalNodeLimitExceeded: "traversalNodeLimitExceeded"
        case .traversalCycleDetected: "traversalCycleDetected"
        case .traversalDeadlineExceeded: "traversalDeadlineExceeded"
        }
    }
}
