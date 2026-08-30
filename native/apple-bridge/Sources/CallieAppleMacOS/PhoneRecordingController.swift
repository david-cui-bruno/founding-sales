import Foundation
import CallieAppleCore

public struct PhoneCallAuthorization: Equatable, Sendable {
    public let call: ObservedCall
    public let observationGeneration: UInt64
    public let sessionFingerprint: String

    public init(call: ObservedCall, observationGeneration: UInt64, sessionFingerprint: String) {
        self.call = call
        self.observationGeneration = observationGeneration
        self.sessionFingerprint = sessionFingerprint
    }
}

public protocol CurrentPhoneCallReading: Sendable {
    func currentAuthorization() -> PhoneCallAuthorization?
    func isCurrent(_ authorization: PhoneCallAuthorization) -> Bool
}

public protocol CurrentPhoneCallRegistering: CurrentPhoneCallReading {
    func replace(_ authorization: PhoneCallAuthorization)
    func clear(observationGeneration: UInt64)
}

public final class LockedCurrentPhoneCallRegistry: CurrentPhoneCallRegistering, @unchecked Sendable {
    private let lock = NSLock()
    private var current: PhoneCallAuthorization?

    public init() {}

    public func currentAuthorization() -> PhoneCallAuthorization? { lock.withLock { current } }
    public func isCurrent(_ authorization: PhoneCallAuthorization) -> Bool { lock.withLock { current == authorization } }
    public func replace(_ authorization: PhoneCallAuthorization) { lock.withLock { current = authorization } }
    public func clear(observationGeneration: UInt64) {
        lock.withLock {
            if current?.observationGeneration == observationGeneration { current = nil }
        }
    }
}

public struct PhoneRecordingController<Snapshotter: AXSnapshotting, Actuator: AXActuating, Registry: CurrentPhoneCallReading>: RecordingControlling, Sendable {
    private let client: PhoneAccessibilityClient<Snapshotter, Actuator>
    private let registry: Registry

    public init(client: PhoneAccessibilityClient<Snapshotter, Actuator>, registry: Registry) {
        self.client = client
        self.registry = registry
    }

    public func attemptStart(for call: ObservedCall) async throws -> RecordingVerification {
        guard !call.ended else { return .failed(.callEnded) }
        guard call.connected, !call.onHold else { return .failed(.controllerError) }
        guard let authorization = registry.currentAuthorization(), authorization.call == call else {
            return .failed(.controllerError)
        }
        do {
            return try client.startAndVerifyRecording(
                authorization: authorization,
                isAuthorizationCurrent: { registry.isCurrent(authorization) }
            )
        } catch let error as PhoneAccessibilityError {
            switch error {
            case .controlNotFound, .controlAmbiguous, .controlDisabled, .callWindowNotFound,
                 .callWindowAmbiguous, .callWindowDisabled, .sessionFingerprintUnavailable,
                 .callStateUnavailable, .unsupportedPhoneUIVersion, .callAuthorizationChanged:
                return .failed(.controlNotFound)
            }
        } catch {
            return .failed(.controllerError)
        }
    }
}
