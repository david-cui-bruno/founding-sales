import Testing
@testable import CallieAppleCore
@testable import CallieAppleMacOS

@Test func permissionProbeReadsStatusWithoutInvokingEitherPrompt() {
    let permissions = FakePermissions()
    let probe = PermissionProbe(
        contacts: permissions,
        accessibility: permissions,
        phoneCapabilities: StaticPhoneCapabilities(callObservation: false, recordingControl: false)
    )

    #expect(probe.probe() == CapabilityStatus(
        contacts: .notDetermined,
        accessibility: .notDetermined,
        callObservationAvailable: false,
        recordingControlAvailable: false
    ))
    #expect(permissions.contactRequests == 0)
    #expect(permissions.accessibilityPrompts == 0)
}

private final class FakePermissions: ContactAuthorizationReading, ContactAccessRequesting, AccessibilityAuthorizationReading, AccessibilityAccessPrompting, @unchecked Sendable {
    private(set) var contactRequests = 0
    private(set) var accessibilityPrompts = 0

    func currentContactAccess() -> ContactAccess { .notDetermined }
    func currentAccessibilityAccess() -> AccessibilityAccess { .notDetermined }

    func requestContactAccess() async throws -> Bool {
        contactRequests += 1
        return true
    }

    func promptForAccessibility() -> Bool {
        accessibilityPrompts += 1
        return true
    }
}
