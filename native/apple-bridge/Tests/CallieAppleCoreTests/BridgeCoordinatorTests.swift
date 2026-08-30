import Foundation
import Testing
@testable import CallieAppleCore
import CallieAppleProtocol

@Suite("BridgeCoordinatorTests")
struct BridgeCoordinatorTests {
    @Test func verificationIsTheOnlyPathToRecordingVerified() async {
        let controller = RecordingControllerFake(result: .verified)
        let events = EventLog()
        let coordinator = BridgeCoordinator(
            policy: allowPolicy,
            recordingController: controller,
            eventSink: { event in events.append(event) }
        )

        await coordinator.observe(verifiedCall, identity: .resolved(verifiedHandle, contactMembership: .found), contactAccess: .full)

        #expect(controller.attempts == [verifiedCall.id])
        #expect(events.names == [.callStateChanged, .callIdentityResolved, .recordingAttempted, .recordingVerified])
    }

    @Test func attemptedOrFailedVerificationNeverEmitsVerified() async {
        let controller = RecordingControllerFake(result: .failed(.controlNotFound))
        let events = EventLog()
        let coordinator = BridgeCoordinator(
            policy: allowPolicy,
            recordingController: controller,
            eventSink: { event in events.append(event) }
        )

        await coordinator.observe(verifiedCall, identity: .resolved(verifiedHandle, contactMembership: .found), contactAccess: .full)

        #expect(events.names == [.callStateChanged, .callIdentityResolved, .recordingAttempted, .recordingFailed])
        #expect(!events.names.contains(.recordingVerified))
    }

    @Test func deniedCallDoesNotAttemptRecordingAndDuplicateCallDoesNotRepeatEvents() async {
        let controller = RecordingControllerFake(result: .verified)
        let events = EventLog()
        let coordinator = BridgeCoordinator(
            policy: allowPolicy,
            recordingController: controller,
            eventSink: { event in events.append(event) }
        )

        await coordinator.observe(deniedCall, identity: .unresolved, contactAccess: .full)
        await coordinator.observe(deniedCall, identity: .unresolved, contactAccess: .full)

        #expect(controller.attempts.isEmpty)
        #expect(events.names == [.callStateChanged, .callIdentityUnresolved, .recordingFailed])
    }

    @Test func connectingCallWaitsForConnectedObservationBeforeAttempting() async {
        let controller = RecordingControllerFake(result: .verified)
        let events = EventLog()
        let coordinator = BridgeCoordinator(
            policy: allowPolicy,
            recordingController: controller,
            eventSink: { event in events.append(event) }
        )
        let connecting = ObservedCall(id: verifiedCall.id, outgoing: true, connected: false, ended: false, onHold: false)

        await coordinator.observe(connecting, identity: .resolved(verifiedHandle, contactMembership: .found), contactAccess: .full)
        await coordinator.observe(verifiedCall, identity: .resolved(verifiedHandle, contactMembership: .found), contactAccess: .full)

        #expect(controller.attempts == [verifiedCall.id])
        #expect(events.names == [.callStateChanged, .callStateChanged, .callIdentityResolved, .recordingAttempted, .recordingVerified])
    }
}

private let verifiedHandle = NormalizedHandle("verified-synthetic")
private let verifiedCall = ObservedCall(id: UUID(uuidString: "44444444-4444-4444-8444-444444444444")!, outgoing: true, connected: true, ended: false, onHold: false)
private let deniedCall = ObservedCall(id: UUID(uuidString: "55555555-5555-4555-8555-555555555555")!, outgoing: false, connected: true, ended: false, onHold: false)
private let allowPolicy = RecordingPolicySnapshot(allowsKnownContacts: true, allowsUnknownContacts: true)

private final class RecordingControllerFake: RecordingControlling, @unchecked Sendable {
    let result: RecordingVerification
    private(set) var attempts: [UUID] = []

    init(result: RecordingVerification) { self.result = result }

    func attemptStart(for call: ObservedCall) async throws -> RecordingVerification {
        attempts.append(call.id)
        return result
    }
}

private final class EventLog: @unchecked Sendable {
    private(set) var events: [BridgeEvent] = []

    func append(_ event: BridgeEvent) { events.append(event) }
    var names: [BridgeEventName] { events.map(\.event) }
}
