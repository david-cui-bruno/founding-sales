import Foundation

public enum ContactAccess: Sendable, Equatable {
    case full
    case limited
    case denied
    case restricted
    case notDetermined
}

public enum AccessibilityAccess: Sendable, Equatable {
    case granted
    case denied
    case notDetermined
}

public struct CapabilityStatus: Sendable, Equatable {
    public let contacts: ContactAccess
    public let accessibility: AccessibilityAccess
    public let callObservationAvailable: Bool
    public let recordingControlAvailable: Bool

    public init(
        contacts: ContactAccess,
        accessibility: AccessibilityAccess,
        callObservationAvailable: Bool,
        recordingControlAvailable: Bool
    ) {
        self.contacts = contacts
        self.accessibility = accessibility
        self.callObservationAvailable = callObservationAvailable
        self.recordingControlAvailable = recordingControlAvailable
    }
}
