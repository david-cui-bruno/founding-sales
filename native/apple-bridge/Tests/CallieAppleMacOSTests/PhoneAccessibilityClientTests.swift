import Foundation
import Testing
@testable import CallieAppleCore
@testable import CallieAppleMacOS

@Suite("PhoneAccessibilityClientTests")
struct PhoneAccessibilityClientTests {
    @Test func availableControlIsPressedOnceAndIndependentActiveSnapshotVerifies() throws {
        let initial = try FixtureSupport.snapshot(named: "phone-recording-available")
        let active = try FixtureSupport.snapshot(named: "phone-recording-active")
        let actuator = FakeAXActuator()
        let client = PhoneAccessibilityClient(snapshotter: SequenceSnapshotter([initial, active]), actuator: actuator)

        #expect(try client.startAndVerifyRecording(authorization: fixtureAuthorization, isAuthorizationCurrent: { true }) == .verified)
        #expect(actuator.pressed == ["record-button"])
    }

    @Test func missingRecordingControlFailsWithoutPressingAnything() throws {
        let snapshot = try FixtureSupport.snapshot(named: "phone-recording-missing")
        let actuator = FakeAXActuator()
        let client = PhoneAccessibilityClient(snapshotter: SequenceSnapshotter([snapshot]), actuator: actuator)

        #expect(throws: PhoneAccessibilityError.controlNotFound) {
            try client.startAndVerifyRecording(authorization: fixtureAuthorization, isAuthorizationCurrent: { true })
        }
        #expect(actuator.pressed.isEmpty)
    }

    @Test func ambiguousRecordingControlsFailWithoutPressingAnything() throws {
        let snapshot = try FixtureSupport.snapshot(named: "phone-recording-ambiguous")
        let actuator = FakeAXActuator()
        let client = PhoneAccessibilityClient(snapshotter: SequenceSnapshotter([snapshot]), actuator: actuator)

        #expect(throws: PhoneAccessibilityError.controlAmbiguous) {
            try client.startAndVerifyRecording(authorization: fixtureAuthorization, isAuthorizationCurrent: { true })
        }
        #expect(actuator.pressed.isEmpty)
    }

    @Test func disabledRecordingControlFailsWithoutPressingAnything() throws {
        let snapshot = try FixtureSupport.snapshot(named: "phone-recording-disabled")
        let actuator = FakeAXActuator()
        let client = PhoneAccessibilityClient(snapshotter: SequenceSnapshotter([snapshot]), actuator: actuator)

        #expect(throws: PhoneAccessibilityError.controlDisabled) {
            try client.startAndVerifyRecording(authorization: fixtureAuthorization, isAuthorizationCurrent: { true })
        }
        #expect(actuator.pressed.isEmpty)
    }

    @Test func renamedRecordingControlFailsWithoutPressingAnything() throws {
        let snapshot = try FixtureSupport.snapshot(named: "phone-recording-renamed")
        let actuator = FakeAXActuator()
        let client = PhoneAccessibilityClient(snapshotter: SequenceSnapshotter([snapshot]), actuator: actuator)

        #expect(throws: PhoneAccessibilityError.controlNotFound) {
            try client.startAndVerifyRecording(authorization: fixtureAuthorization, isAuthorizationCurrent: { true })
        }
        #expect(actuator.pressed.isEmpty)
    }

    @Test func pressWithoutIndependentActiveIndicatorReturnsFailedVerification() throws {
        let available = try FixtureSupport.snapshot(named: "phone-recording-available")
        let actuator = FakeAXActuator()
        let client = PhoneAccessibilityClient(snapshotter: SequenceSnapshotter([available, available]), actuator: actuator)

        #expect(try client.startAndVerifyRecording(authorization: fixtureAuthorization, isAuthorizationCurrent: { true }) == .failed(.verificationFailed))
        #expect(actuator.pressed == ["record-button"])
    }

    @Test func recordingControllerMapsMissingControlToFailClosedCoreResult() async throws {
        let missing = try FixtureSupport.snapshot(named: "phone-recording-missing")
        let registry = LockedCurrentPhoneCallRegistry()
        registry.replace(fixtureAuthorization)
        let controller = PhoneRecordingController(
            client: PhoneAccessibilityClient(snapshotter: SequenceSnapshotter([missing]), actuator: FakeAXActuator()),
            registry: registry
        )

        #expect(try await controller.attemptStart(for: fixtureCall) == .failed(.controlNotFound))
    }
}

final class SequenceSnapshotter: AXSnapshotting, @unchecked Sendable {
    private let lock = NSLock()
    private var snapshots: [Result<AXNodeSnapshot, any Error>]

    init(_ snapshots: [AXNodeSnapshot]) {
        self.snapshots = snapshots.map(Result.success)
    }

    init(results: [Result<AXNodeSnapshot, any Error>]) {
        snapshots = results
    }

    func snapshot() throws -> AXNodeSnapshot {
        try lock.withLock {
            guard !snapshots.isEmpty else { throw SyntheticAXError.exhausted }
            return try snapshots.removeFirst().get()
        }
    }
}

final class FakeAXActuator: AXActuating, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String] = []
    var pressed: [String] { lock.withLock { storage } }

    func press(_ request: AXActuationRequest, ifAuthorized: @Sendable () -> Bool) throws {
        guard ifAuthorized() else { throw PhoneAccessibilityError.callAuthorizationChanged }
        lock.withLock { storage.append(request.element.nodeID) }
    }
}

enum SyntheticAXError: Error { case exhausted, permissionDenied }
