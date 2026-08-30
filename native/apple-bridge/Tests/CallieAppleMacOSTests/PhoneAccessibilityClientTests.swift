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

        #expect(try client.startAndVerifyRecording() == .verified)
        #expect(actuator.pressed == ["record-button"])
    }

    @Test func missingRecordingControlFailsWithoutPressingAnything() throws {
        let snapshot = try FixtureSupport.snapshot(named: "phone-recording-missing")
        let actuator = FakeAXActuator()
        let client = PhoneAccessibilityClient(snapshotter: SequenceSnapshotter([snapshot]), actuator: actuator)

        #expect(throws: PhoneAccessibilityError.controlNotFound) {
            try client.startAndVerifyRecording()
        }
        #expect(actuator.pressed.isEmpty)
    }

    @Test func ambiguousRecordingControlsFailWithoutPressingAnything() throws {
        let snapshot = try FixtureSupport.snapshot(named: "phone-recording-ambiguous")
        let actuator = FakeAXActuator()
        let client = PhoneAccessibilityClient(snapshotter: SequenceSnapshotter([snapshot]), actuator: actuator)

        #expect(throws: PhoneAccessibilityError.controlAmbiguous) {
            try client.startAndVerifyRecording()
        }
        #expect(actuator.pressed.isEmpty)
    }

    @Test func disabledRecordingControlFailsWithoutPressingAnything() throws {
        let snapshot = try FixtureSupport.snapshot(named: "phone-recording-disabled")
        let actuator = FakeAXActuator()
        let client = PhoneAccessibilityClient(snapshotter: SequenceSnapshotter([snapshot]), actuator: actuator)

        #expect(throws: PhoneAccessibilityError.controlDisabled) {
            try client.startAndVerifyRecording()
        }
        #expect(actuator.pressed.isEmpty)
    }

    @Test func renamedRecordingControlFailsWithoutPressingAnything() throws {
        let snapshot = try FixtureSupport.snapshot(named: "phone-recording-renamed")
        let actuator = FakeAXActuator()
        let client = PhoneAccessibilityClient(snapshotter: SequenceSnapshotter([snapshot]), actuator: actuator)

        #expect(throws: PhoneAccessibilityError.controlNotFound) {
            try client.startAndVerifyRecording()
        }
        #expect(actuator.pressed.isEmpty)
    }

    @Test func pressWithoutIndependentActiveIndicatorReturnsFailedVerification() throws {
        let available = try FixtureSupport.snapshot(named: "phone-recording-available")
        let actuator = FakeAXActuator()
        let client = PhoneAccessibilityClient(snapshotter: SequenceSnapshotter([available, available]), actuator: actuator)

        #expect(try client.startAndVerifyRecording() == .failed(.verificationFailed))
        #expect(actuator.pressed == ["record-button"])
    }

    @Test func recordingControllerMapsMissingControlToFailClosedCoreResult() async throws {
        let missing = try FixtureSupport.snapshot(named: "phone-recording-missing")
        let controller = PhoneRecordingController(
            client: PhoneAccessibilityClient(snapshotter: SequenceSnapshotter([missing]), actuator: FakeAXActuator())
        )

        #expect(try await controller.attemptStart(for: syntheticCall) == .failed(.controlNotFound))
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

    func press(nodeID: String) throws {
        lock.withLock { storage.append(nodeID) }
    }
}

enum SyntheticAXError: Error { case exhausted, permissionDenied }
private let syntheticCall = ObservedCall(id: UUID(uuidString: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")!, outgoing: true, connected: true, ended: false, onHold: false)
