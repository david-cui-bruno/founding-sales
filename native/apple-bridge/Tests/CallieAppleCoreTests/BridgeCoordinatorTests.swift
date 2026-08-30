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
        assertEvents(events.events, [
            (.callStateChanged, safetyPayload(for: verifiedCall, identity: "resolved", membership: .string("found"), contactAccess: "full")),
            (.callIdentityResolved, safetyPayload(for: verifiedCall, identity: "resolved", membership: .string("found"), contactAccess: "full")),
            (.recordingAttempted, safetyPayload(for: verifiedCall, identity: "resolved", membership: .string("found"), contactAccess: "full", extra: ["reason": .string("knownContact")])),
            (.recordingVerified, safetyPayload(for: verifiedCall, identity: "resolved", membership: .string("found"), contactAccess: "full", extra: ["verification": .string("verified")])),
        ])
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

        assertEvents(events.events, [
            (.callStateChanged, safetyPayload(for: verifiedCall, identity: "resolved", membership: .string("found"), contactAccess: "full")),
            (.callIdentityResolved, safetyPayload(for: verifiedCall, identity: "resolved", membership: .string("found"), contactAccess: "full")),
            (.recordingAttempted, safetyPayload(for: verifiedCall, identity: "resolved", membership: .string("found"), contactAccess: "full", extra: ["reason": .string("knownContact")])),
            (.recordingFailed, safetyPayload(for: verifiedCall, identity: "resolved", membership: .string("found"), contactAccess: "full", extra: ["failure": .string("controlNotFound")])),
        ])
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
        assertEvents(events.events, [
            (.callStateChanged, safetyPayload(for: deniedCall, identity: "unresolved", membership: .null, contactAccess: "full")),
            (.callIdentityUnresolved, safetyPayload(for: deniedCall, identity: "unresolved", membership: .null, contactAccess: "full")),
            (.recordingFailed, safetyPayload(for: deniedCall, identity: "unresolved", membership: .null, contactAccess: "full", extra: ["denial": .string("identityUnresolved")])),
        ])
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
        assertEvents(events.events, [
            (.callStateChanged, safetyPayload(for: connecting, identity: "resolved", membership: .string("found"), contactAccess: "full")),
            (.callStateChanged, safetyPayload(for: verifiedCall, identity: "resolved", membership: .string("found"), contactAccess: "full")),
            (.callIdentityResolved, safetyPayload(for: verifiedCall, identity: "resolved", membership: .string("found"), contactAccess: "full")),
            (.recordingAttempted, safetyPayload(for: verifiedCall, identity: "resolved", membership: .string("found"), contactAccess: "full", extra: ["reason": .string("knownContact")])),
            (.recordingVerified, safetyPayload(for: verifiedCall, identity: "resolved", membership: .string("found"), contactAccess: "full", extra: ["verification": .string("verified")])),
        ])
    }

    @Test func unresolvedIdentityDuringInFlightAttemptCannotVerifyRecording() async {
        let controller = SuspendedRecordingController()
        let events = EventLog()
        let coordinator = BridgeCoordinator(policy: allowPolicy, recordingController: controller, eventSink: { events.append($0) })

        let attempt = Task {
            await coordinator.observe(verifiedCall, identity: .resolved(verifiedHandle, contactMembership: .found), contactAccess: .full)
        }
        await controller.waitUntilAttempted()
        await coordinator.observe(verifiedCall, identity: .unresolved, contactAccess: .full)
        await controller.finish(with: .verified)
        await attempt.value

        #expect(!events.names.contains(.recordingVerified))
        #expect(events.events.last?.event == .recordingFailed)
        #expect(events.events.last?.payload["denial"] == .string("identityUnresolved"))
        #expect(events.events.last?.payload["identity"] == .string("unresolved"))
        #expect(events.events.last?.payload["contactAccess"] == .string("full"))
        #expect(await coordinator.recordingState(for: verifiedCall.id) == .failed(.eligibilityChanged))
        assertContiguousEventFrames(events.events)
    }

    @Test func reducedContactsAccessDuringInFlightUnknownAttemptCannotVerifyRecording() async {
        let controller = SuspendedRecordingController()
        let events = EventLog()
        let coordinator = BridgeCoordinator(policy: allowPolicy, recordingController: controller, eventSink: { events.append($0) })
        let unknownIdentity = IdentityResolution.resolved(unknownHandle, contactMembership: .notFound)

        let attempt = Task {
            await coordinator.observe(verifiedCall, identity: unknownIdentity, contactAccess: .full)
        }
        await controller.waitUntilAttempted()
        await coordinator.observe(verifiedCall, identity: unknownIdentity, contactAccess: .limited)
        await controller.finish(with: .verified)
        await attempt.value

        #expect(!events.names.contains(.recordingVerified))
        #expect(events.events.last?.event == .recordingFailed)
        #expect(events.events.last?.payload["denial"] == .string("fullContactsRequired"))
        #expect(events.events.last?.payload["identity"] == .string("resolved"))
        #expect(events.events.last?.payload["contactAccess"] == .string("limited"))
        #expect(await coordinator.recordingState(for: verifiedCall.id) == .failed(.eligibilityChanged))
        assertContiguousEventFrames(events.events)
    }

    @Test func deniedContactsAccessDuringInFlightUnknownAttemptCannotVerifyRecording() async {
        let controller = SuspendedRecordingController()
        let events = EventLog()
        let coordinator = BridgeCoordinator(policy: allowPolicy, recordingController: controller, eventSink: { events.append($0) })
        let unknownIdentity = IdentityResolution.resolved(unknownHandle, contactMembership: .notFound)

        let attempt = Task {
            await coordinator.observe(verifiedCall, identity: unknownIdentity, contactAccess: .full)
        }
        await controller.waitUntilAttempted()
        await coordinator.observe(verifiedCall, identity: unknownIdentity, contactAccess: .denied)
        await controller.finish(with: .verified)
        await attempt.value

        #expect(!events.names.contains(.recordingVerified))
        #expect(events.events.last?.event == .recordingFailed)
        #expect(events.events.last?.payload["denial"] == .string("fullContactsRequired"))
        #expect(events.events.last?.payload["contactAccess"] == .string("denied"))
        #expect(await coordinator.recordingState(for: verifiedCall.id) == .failed(.eligibilityChanged))
        assertContiguousEventFrames(events.events)
    }

    @Test func endedCallDuringInFlightAttemptCannotVerifyRecording() async {
        let controller = SuspendedRecordingController()
        let events = EventLog()
        let coordinator = BridgeCoordinator(policy: allowPolicy, recordingController: controller, eventSink: { events.append($0) })
        let ended = ObservedCall(id: verifiedCall.id, outgoing: true, connected: true, ended: true, onHold: false)

        let attempt = Task {
            await coordinator.observe(verifiedCall, identity: .resolved(verifiedHandle, contactMembership: .found), contactAccess: .full)
        }
        await controller.waitUntilAttempted()
        await coordinator.observe(ended, identity: .resolved(verifiedHandle, contactMembership: .found), contactAccess: .full)
        await controller.finish(with: .verified)
        await attempt.value

        #expect(!events.names.contains(.recordingVerified))
        #expect(events.events.last?.event == .recordingFailed)
        #expect(events.events.last?.payload["denial"] == .string("callNotRecordable"))
        #expect(events.events.last?.payload["ended"] == .bool(true))
        #expect(await coordinator.recordingState(for: verifiedCall.id) == .failed(.callEnded))
        assertContiguousEventFrames(events.events)
    }

    @Test func staleConnectingObservationDuringInFlightAttemptCannotInvalidateCurrentCall() async {
        let controller = SuspendedRecordingController()
        let events = EventLog()
        let coordinator = BridgeCoordinator(policy: allowPolicy, recordingController: controller, eventSink: { events.append($0) })
        let staleConnecting = ObservedCall(id: verifiedCall.id, outgoing: true, connected: false, ended: false, onHold: false)

        let attempt = Task {
            await coordinator.observe(verifiedCall, identity: .resolved(verifiedHandle, contactMembership: .found), contactAccess: .full)
        }
        await controller.waitUntilAttempted()
        await coordinator.observe(staleConnecting, identity: .resolved(verifiedHandle, contactMembership: .found), contactAccess: .full)
        await controller.finish(with: .verified)
        await attempt.value

        #expect(events.events.last?.event == .recordingVerified)
        #expect(await coordinator.recordingState(for: verifiedCall.id) == .verified)
        assertContiguousEventFrames(events.events)
    }

    @Test func staleConnectingUnsafeObservationDuringInFlightAttemptIsIgnoredAtomically() async {
        let controller = SuspendedRecordingController()
        let events = EventLog()
        let coordinator = BridgeCoordinator(policy: allowPolicy, recordingController: controller, eventSink: { events.append($0) })
        let staleConnecting = ObservedCall(id: verifiedCall.id, outgoing: true, connected: false, ended: false, onHold: false)

        let attempt = Task {
            await coordinator.observe(verifiedCall, identity: .resolved(verifiedHandle, contactMembership: .found), contactAccess: .full)
        }
        await controller.waitUntilAttempted()
        await coordinator.observe(staleConnecting, identity: .unresolved, contactAccess: .denied)
        await controller.finish(with: .verified)
        await attempt.value

        #expect(events.events.last?.event == .recordingVerified)
        #expect(events.events.last?.payload == safetyPayload(for: verifiedCall, identity: "resolved", membership: .string("found"), contactAccess: "full", extra: ["verification": .string("verified")]))
        #expect(await coordinator.recordingState(for: verifiedCall.id) == .verified)
        assertContiguousEventFrames(events.events)
    }

    @Test func exactDuplicateWithUnsafeIdentityAndContactsInvalidatesInFlightAttempt() async {
        let controller = SuspendedRecordingController()
        let events = EventLog()
        let coordinator = BridgeCoordinator(policy: allowPolicy, recordingController: controller, eventSink: { events.append($0) })

        let attempt = Task {
            await coordinator.observe(verifiedCall, identity: .resolved(verifiedHandle, contactMembership: .found), contactAccess: .full)
        }
        await controller.waitUntilAttempted()
        await coordinator.observe(verifiedCall, identity: .unresolved, contactAccess: .denied)
        await controller.finish(with: .verified)
        await attempt.value

        #expect(!events.names.contains(.recordingVerified))
        #expect(events.events.last?.payload == safetyPayload(for: verifiedCall, identity: "unresolved", membership: .null, contactAccess: "denied", extra: ["denial": .string("identityUnresolved"), "failure": .string("eligibilityChanged")]))
        #expect(await coordinator.recordingState(for: verifiedCall.id) == .failed(.eligibilityChanged))
        assertContiguousEventFrames(events.events)
    }

    @Test func policyChangeDuringInFlightAttemptCannotVerifyRecording() async {
        let controller = SuspendedRecordingController()
        let events = EventLog()
        let coordinator = BridgeCoordinator(policy: allowPolicy, recordingController: controller, eventSink: { events.append($0) })

        let attempt = Task {
            await coordinator.observe(verifiedCall, identity: .resolved(verifiedHandle, contactMembership: .found), contactAccess: .full)
        }
        await controller.waitUntilAttempted()
        await coordinator.updatePolicy(.init(allowsKnownContacts: false, allowsUnknownContacts: true))
        await controller.finish(with: .verified)
        await attempt.value

        #expect(!events.names.contains(.recordingVerified))
        #expect(events.events.last?.event == .recordingFailed)
        #expect(events.events.last?.payload["denial"] == .string("knownContactDisallowed"))
        #expect(await coordinator.recordingState(for: verifiedCall.id) == .failed(.eligibilityChanged))
        assertContiguousEventFrames(events.events)
    }
}

private let verifiedHandle = NormalizedHandle("verified-synthetic")
private let unknownHandle = NormalizedHandle("unknown-synthetic")
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

private actor SuspendedRecordingController: RecordingControlling {
    private var attempts: [UUID] = []
    private var attemptWaiters: [CheckedContinuation<Void, Never>] = []
    private var completion: CheckedContinuation<RecordingVerification, Never>?

    func attemptStart(for call: ObservedCall) async throws -> RecordingVerification {
        attempts.append(call.id)
        let waiters = attemptWaiters
        attemptWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
        return await withCheckedContinuation { completion = $0 }
    }

    func waitUntilAttempted() async {
        guard attempts.isEmpty else { return }
        await withCheckedContinuation { attemptWaiters.append($0) }
    }

    func finish(with verification: RecordingVerification) {
        let current = completion
        completion = nil
        current?.resume(returning: verification)
    }
}

private func assertContiguousEventFrames(_ events: [BridgeEvent]) {
    #expect(events.map(\.seq) == Array(events.indices))
    for event in events {
        #expect(event.payload["callId"] == .string(verifiedCall.id.uuidString.lowercased()))
        #expect(event.payload["outgoing"] == .bool(true))
        #expect(event.payload["connected"] != nil)
        #expect(event.payload["ended"] != nil)
        #expect(event.payload["onHold"] != nil)
        #expect(event.payload["identity"] != nil)
        #expect(event.payload["contactAccess"] != nil)
    }
}

private func assertEvents(_ events: [BridgeEvent], _ expected: [(BridgeEventName, [String: JSONValue])]) {
    #expect(events.count == expected.count)
    for (index, pair) in expected.enumerated() where index < events.count {
        #expect(events[index].seq == index)
        #expect(events[index].event == pair.0)
        #expect(events[index].payload == pair.1)
    }
}

private func safetyPayload(
    for call: ObservedCall,
    identity: String,
    membership: JSONValue,
    contactAccess: String,
    extra: [String: JSONValue] = [:]
) -> [String: JSONValue] {
    var payload: [String: JSONValue] = [
        "callId": .string(call.id.uuidString.lowercased()),
        "outgoing": .bool(call.outgoing),
        "connected": .bool(call.connected),
        "ended": .bool(call.ended),
        "onHold": .bool(call.onHold),
        "identity": .string(identity),
        "contactMembership": membership,
        "contactAccess": .string(contactAccess),
        "policyAllowsKnownContacts": .bool(allowPolicy.allowsKnownContacts),
        "policyAllowsUnknownContacts": .bool(allowPolicy.allowsUnknownContacts),
    ]
    for (key, value) in extra { payload[key] = value }
    return payload
}
