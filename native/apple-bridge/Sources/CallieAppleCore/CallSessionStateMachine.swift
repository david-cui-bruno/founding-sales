import Foundation

public enum CallSessionState: Sendable, Equatable {
    case connecting
    case connected
    case held
    case ended
}

public enum RecordingState: Sendable, Equatable {
    case idle
    case attempted
    case verified
    case failed(RecordingFailure)
}

public enum CallSessionEvent: Sendable, Equatable {
    case observed(ObservedCall)
    case recordingAttempted(at: Date)
    case recordingVerified(at: Date)
    case recordingVerificationFailed(RecordingFailure)
}

public enum CallObservationDisposition: Sendable, Equatable {
    case accepted
    case duplicate
    case rejectedStale
}

public struct CallSessionStateMachine: Sendable, Equatable {
    public private(set) var call: ObservedCall
    public private(set) var callState: CallSessionState
    public private(set) var recordingState: RecordingState

    public init(call: ObservedCall) {
        self.call = call
        callState = Self.callState(for: call)
        recordingState = call.ended ? .failed(.callEnded) : .idle
    }

    @discardableResult
    public mutating func apply(_ event: CallSessionEvent) -> Bool {
        switch event {
        case let .observed(updatedCall):
            return applyObservation(updatedCall) == .accepted
        case .recordingAttempted:
            guard callState == .connected, recordingState == .idle else { return false }
            recordingState = .attempted
            return true
        case .recordingVerified:
            guard callState == .connected, recordingState == .attempted else { return false }
            recordingState = .verified
            return true
        case let .recordingVerificationFailed(failure):
            guard callState != .ended, recordingState == .attempted else { return false }
            recordingState = .failed(failure)
            return true
        }
    }

    @discardableResult
    public mutating func applyObservation(_ updatedCall: ObservedCall) -> CallObservationDisposition {
        guard updatedCall.id == call.id else { return .rejectedStale }
        guard updatedCall != call else { return .duplicate }
        let updatedState = Self.callState(for: updatedCall)
        guard Self.canAdvance(from: callState, to: updatedState) else { return .rejectedStale }
        call = updatedCall
        callState = updatedState
        if updatedCall.ended, recordingState != .verified, recordingState != .failed(.callEnded) {
            recordingState = .failed(.callEnded)
        }
        return .accepted
    }

    private static func callState(for call: ObservedCall) -> CallSessionState {
        if call.ended { return .ended }
        if call.onHold { return .held }
        return call.connected ? .connected : .connecting
    }

    private static func canAdvance(from current: CallSessionState, to updated: CallSessionState) -> Bool {
        switch (current, updated) {
        case (.ended, _), (.connected, .connecting), (.held, .connecting):
            return false
        default:
            return true
        }
    }
}
