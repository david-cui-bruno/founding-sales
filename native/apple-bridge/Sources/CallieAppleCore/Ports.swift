import Foundation

public protocol CallObserving: Sendable {
    func start(_ sink: @escaping @Sendable (ObservedCall) -> Void) throws
    func stop()
}

public enum RecordingFailure: Sendable, Equatable {
    case controlNotFound
    case verificationFailed
    case callEnded
    case controllerError
}

public enum RecordingVerification: Sendable, Equatable {
    case verified
    case failed(RecordingFailure)
}

public protocol RecordingControlling: Sendable {
    func attemptStart(for call: ObservedCall) async throws -> RecordingVerification
}

public protocol CapabilityProbing: Sendable {
    func probe() -> CapabilityStatus
}
