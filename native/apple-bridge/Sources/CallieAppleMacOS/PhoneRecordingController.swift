import CallieAppleCore

public struct PhoneRecordingController<Snapshotter: AXSnapshotting, Actuator: AXActuating>: RecordingControlling, Sendable {
    private let client: PhoneAccessibilityClient<Snapshotter, Actuator>

    public init(client: PhoneAccessibilityClient<Snapshotter, Actuator>) {
        self.client = client
    }

    public func attemptStart(for call: ObservedCall) async throws -> RecordingVerification {
        do {
            return try client.startAndVerifyRecording()
        } catch let error as PhoneAccessibilityError {
            switch error {
            case .controlNotFound, .controlAmbiguous, .controlDisabled, .unsupportedPhoneUIVersion:
                return .failed(.controlNotFound)
            }
        } catch {
            return .failed(.controllerError)
        }
    }
}
