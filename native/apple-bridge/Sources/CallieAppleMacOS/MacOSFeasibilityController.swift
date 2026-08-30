import CallieAppleCore
import Foundation

/// Owns the explicitly-commanded permission and Phone-observation adapters.
/// Construction and capability probing never prompt or start observation.
public actor MacOSFeasibilityController: AppleFeasibilityControlling {
    private let contacts: any ContactAuthorizationReading & ContactAccessRequesting
    private let accessibility: any AccessibilityAuthorizationReading & AccessibilityAccessPrompting
    private let observer: any CallObserving
    private let observationAvailable: Bool
    private var observing = false

    public init<Contacts, Accessibility>(
        contacts: Contacts,
        accessibility: Accessibility,
        observer: any CallObserving,
        callObservationAvailable: Bool
    ) where
        Contacts: ContactAuthorizationReading & ContactAccessRequesting,
        Accessibility: AccessibilityAuthorizationReading & AccessibilityAccessPrompting
    {
        self.contacts = contacts
        self.accessibility = accessibility
        self.observer = observer
        observationAvailable = callObservationAvailable
    }

    public func probeCapabilities() -> CapabilityStatus {
        CapabilityStatus(
            contacts: contacts.currentContactAccess(),
            accessibility: accessibility.currentAccessibilityAccess(),
            callObservationAvailable: observationAvailable,
            recordingControlAvailable: false
        )
    }

    public func requestContactAccess() async throws -> ContactAccess {
        do {
            _ = try await contacts.requestContactAccess()
            return contacts.currentContactAccess()
        } catch {
            throw AppleFeasibilityControlError.permissionRequestFailed
        }
    }

    public func promptForAccessibility() -> Bool {
        accessibility.promptForAccessibility()
    }

    public func startCallObservation() throws -> Bool {
        guard observationAvailable else {
            throw AppleFeasibilityControlError.callObservationUnavailable
        }
        guard !observing else { return true }
        do {
            try observer.start { _ in }
            observing = true
            return true
        } catch {
            throw AppleFeasibilityControlError.callObservationUnavailable
        }
    }

    public func stopCallObservation() -> Bool {
        guard observing else { return false }
        observer.stop()
        observing = false
        return false
    }
}
