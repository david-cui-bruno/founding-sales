@preconcurrency import ApplicationServices
import Foundation
import CallieAppleCore

public protocol AccessibilityAuthorizationReading: Sendable {
    func currentAccessibilityAccess() -> AccessibilityAccess
}

public protocol AccessibilityAccessPrompting: Sendable {
    func promptForAccessibility() -> Bool
}

public protocol PhoneCapabilityReading: Sendable {
    func callObservationAvailable() -> Bool
    func recordingControlAvailable() -> Bool
}

public struct StaticPhoneCapabilities: PhoneCapabilityReading, Sendable {
    private let callObservation: Bool
    private let recordingControl: Bool

    public init(callObservation: Bool, recordingControl: Bool) {
        self.callObservation = callObservation
        self.recordingControl = recordingControl
    }

    public func callObservationAvailable() -> Bool { callObservation }
    public func recordingControlAvailable() -> Bool { recordingControl }
}

public struct PermissionProbe<Contacts: ContactAuthorizationReading, Accessibility: AccessibilityAuthorizationReading, Phone: PhoneCapabilityReading>: CapabilityProbing, Sendable {
    private let contacts: Contacts
    private let accessibility: Accessibility
    private let phoneCapabilities: Phone

    public init(contacts: Contacts, accessibility: Accessibility, phoneCapabilities: Phone) {
        self.contacts = contacts
        self.accessibility = accessibility
        self.phoneCapabilities = phoneCapabilities
    }

    public func probe() -> CapabilityStatus {
        CapabilityStatus(
            contacts: contacts.currentContactAccess(),
            accessibility: accessibility.currentAccessibilityAccess(),
            callObservationAvailable: phoneCapabilities.callObservationAvailable(),
            recordingControlAvailable: phoneCapabilities.recordingControlAvailable()
        )
    }
}

/// The only production boundary that reads or explicitly prompts Accessibility TCC.
public struct SystemAccessibilityAuthorization: AccessibilityAuthorizationReading, AccessibilityAccessPrompting, Sendable {
    public init() {}

    public func currentAccessibilityAccess() -> AccessibilityAccess {
        AXIsProcessTrusted() ? .granted : .denied
    }

    public func promptForAccessibility() -> Bool {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        return AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
    }
}
