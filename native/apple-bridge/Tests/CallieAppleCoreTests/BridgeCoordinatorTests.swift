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
        assertEvents(events.events, knownVerifiedFrames)
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

        assertEvents(events.events, knownControlFailureFrames)
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
        assertEvents(events.events, deniedInitialFrames)
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
        assertEvents(events.events, connectingThenKnownVerifiedFrames)
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

        assertEvents(events.events, identityInvalidationFrames)
        #expect(await coordinator.recordingState(for: verifiedCall.id) == .failed(.eligibilityChanged))
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

        assertEvents(events.events, limitedContactsInvalidationFrames)
        #expect(await coordinator.recordingState(for: verifiedCall.id) == .failed(.eligibilityChanged))
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

        assertEvents(events.events, deniedContactsInvalidationFrames)
        #expect(await coordinator.recordingState(for: verifiedCall.id) == .failed(.eligibilityChanged))
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

        assertEvents(events.events, endedInvalidationFrames)
        #expect(await coordinator.recordingState(for: verifiedCall.id) == .failed(.callEnded))
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

        assertEvents(events.events, knownVerifiedFrames)
        #expect(await coordinator.recordingState(for: verifiedCall.id) == .verified)
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

        assertEvents(events.events, knownVerifiedFrames)
        #expect(await coordinator.recordingState(for: verifiedCall.id) == .verified)
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

        assertEvents(events.events, exactUnsafeInvalidationFrames)
        #expect(await coordinator.recordingState(for: verifiedCall.id) == .failed(.eligibilityChanged))
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

        assertEvents(events.events, policyInvalidationFrames)
        #expect(await coordinator.recordingState(for: verifiedCall.id) == .failed(.eligibilityChanged))
    }
}

private let verifiedHandle = NormalizedHandle("verified-synthetic")
private let unknownHandle = NormalizedHandle("unknown-synthetic")
private let verifiedCall = ObservedCall(id: UUID(uuidString: "44444444-4444-4444-8444-444444444444")!, outgoing: true, connected: true, ended: false, onHold: false)
private let deniedCall = ObservedCall(id: UUID(uuidString: "55555555-5555-4555-8555-555555555555")!, outgoing: false, connected: true, ended: false, onHold: false)
private let allowPolicy = RecordingPolicySnapshot(allowsKnownContacts: true, allowsUnknownContacts: true)

private let knownBase: [String: JSONValue] = ["callId": .string("44444444-4444-4444-8444-444444444444"), "outgoing": .bool(true), "connected": .bool(true), "ended": .bool(false), "onHold": .bool(false), "identity": .string("resolved"), "contactMembership": .string("found"), "contactAccess": .string("full"), "policyAllowsKnownContacts": .bool(true), "policyAllowsUnknownContacts": .bool(true)]
private let knownAttempt: [String: JSONValue] = ["callId": .string("44444444-4444-4444-8444-444444444444"), "outgoing": .bool(true), "connected": .bool(true), "ended": .bool(false), "onHold": .bool(false), "identity": .string("resolved"), "contactMembership": .string("found"), "contactAccess": .string("full"), "policyAllowsKnownContacts": .bool(true), "policyAllowsUnknownContacts": .bool(true), "reason": .string("knownContact")]
private let knownVerified: [String: JSONValue] = ["callId": .string("44444444-4444-4444-8444-444444444444"), "outgoing": .bool(true), "connected": .bool(true), "ended": .bool(false), "onHold": .bool(false), "identity": .string("resolved"), "contactMembership": .string("found"), "contactAccess": .string("full"), "policyAllowsKnownContacts": .bool(true), "policyAllowsUnknownContacts": .bool(true), "verification": .string("verified")]
private let knownControlFailure: [String: JSONValue] = ["callId": .string("44444444-4444-4444-8444-444444444444"), "outgoing": .bool(true), "connected": .bool(true), "ended": .bool(false), "onHold": .bool(false), "identity": .string("resolved"), "contactMembership": .string("found"), "contactAccess": .string("full"), "policyAllowsKnownContacts": .bool(true), "policyAllowsUnknownContacts": .bool(true), "failure": .string("controlNotFound")]
private let unresolvedBase: [String: JSONValue] = ["callId": .string("44444444-4444-4444-8444-444444444444"), "outgoing": .bool(true), "connected": .bool(true), "ended": .bool(false), "onHold": .bool(false), "identity": .string("unresolved"), "contactMembership": .null, "contactAccess": .string("full"), "policyAllowsKnownContacts": .bool(true), "policyAllowsUnknownContacts": .bool(true)]
private let unresolvedFull: [String: JSONValue] = ["callId": .string("44444444-4444-4444-8444-444444444444"), "outgoing": .bool(true), "connected": .bool(true), "ended": .bool(false), "onHold": .bool(false), "identity": .string("unresolved"), "contactMembership": .null, "contactAccess": .string("full"), "policyAllowsKnownContacts": .bool(true), "policyAllowsUnknownContacts": .bool(true), "denial": .string("identityUnresolved"), "failure": .string("eligibilityChanged")]
private let unknownFull: [String: JSONValue] = ["callId": .string("44444444-4444-4444-8444-444444444444"), "outgoing": .bool(true), "connected": .bool(true), "ended": .bool(false), "onHold": .bool(false), "identity": .string("resolved"), "contactMembership": .string("notFound"), "contactAccess": .string("full"), "policyAllowsKnownContacts": .bool(true), "policyAllowsUnknownContacts": .bool(true)]
private let unknownAttempt: [String: JSONValue] = ["callId": .string("44444444-4444-4444-8444-444444444444"), "outgoing": .bool(true), "connected": .bool(true), "ended": .bool(false), "onHold": .bool(false), "identity": .string("resolved"), "contactMembership": .string("notFound"), "contactAccess": .string("full"), "policyAllowsKnownContacts": .bool(true), "policyAllowsUnknownContacts": .bool(true), "reason": .string("unknownContact")]
private let unknownLimitedBase: [String: JSONValue] = ["callId": .string("44444444-4444-4444-8444-444444444444"), "outgoing": .bool(true), "connected": .bool(true), "ended": .bool(false), "onHold": .bool(false), "identity": .string("resolved"), "contactMembership": .string("notFound"), "contactAccess": .string("limited"), "policyAllowsKnownContacts": .bool(true), "policyAllowsUnknownContacts": .bool(true)]
private let unknownLimitedFailure: [String: JSONValue] = ["callId": .string("44444444-4444-4444-8444-444444444444"), "outgoing": .bool(true), "connected": .bool(true), "ended": .bool(false), "onHold": .bool(false), "identity": .string("resolved"), "contactMembership": .string("notFound"), "contactAccess": .string("limited"), "policyAllowsKnownContacts": .bool(true), "policyAllowsUnknownContacts": .bool(true), "denial": .string("fullContactsRequired"), "failure": .string("eligibilityChanged")]
private let unknownDeniedBase: [String: JSONValue] = ["callId": .string("44444444-4444-4444-8444-444444444444"), "outgoing": .bool(true), "connected": .bool(true), "ended": .bool(false), "onHold": .bool(false), "identity": .string("resolved"), "contactMembership": .string("notFound"), "contactAccess": .string("denied"), "policyAllowsKnownContacts": .bool(true), "policyAllowsUnknownContacts": .bool(true)]
private let unknownDeniedFailure: [String: JSONValue] = ["callId": .string("44444444-4444-4444-8444-444444444444"), "outgoing": .bool(true), "connected": .bool(true), "ended": .bool(false), "onHold": .bool(false), "identity": .string("resolved"), "contactMembership": .string("notFound"), "contactAccess": .string("denied"), "policyAllowsKnownContacts": .bool(true), "policyAllowsUnknownContacts": .bool(true), "denial": .string("fullContactsRequired"), "failure": .string("eligibilityChanged")]
private let endedBase: [String: JSONValue] = ["callId": .string("44444444-4444-4444-8444-444444444444"), "outgoing": .bool(true), "connected": .bool(true), "ended": .bool(true), "onHold": .bool(false), "identity": .string("resolved"), "contactMembership": .string("found"), "contactAccess": .string("full"), "policyAllowsKnownContacts": .bool(true), "policyAllowsUnknownContacts": .bool(true)]
private let endedFailure: [String: JSONValue] = ["callId": .string("44444444-4444-4444-8444-444444444444"), "outgoing": .bool(true), "connected": .bool(true), "ended": .bool(true), "onHold": .bool(false), "identity": .string("resolved"), "contactMembership": .string("found"), "contactAccess": .string("full"), "policyAllowsKnownContacts": .bool(true), "policyAllowsUnknownContacts": .bool(true), "denial": .string("callNotRecordable"), "failure": .string("callEnded")]
private let unsafeDeniedBase: [String: JSONValue] = ["callId": .string("44444444-4444-4444-8444-444444444444"), "outgoing": .bool(true), "connected": .bool(true), "ended": .bool(false), "onHold": .bool(false), "identity": .string("unresolved"), "contactMembership": .null, "contactAccess": .string("denied"), "policyAllowsKnownContacts": .bool(true), "policyAllowsUnknownContacts": .bool(true)]
private let unsafeDenied: [String: JSONValue] = ["callId": .string("44444444-4444-4444-8444-444444444444"), "outgoing": .bool(true), "connected": .bool(true), "ended": .bool(false), "onHold": .bool(false), "identity": .string("unresolved"), "contactMembership": .null, "contactAccess": .string("denied"), "policyAllowsKnownContacts": .bool(true), "policyAllowsUnknownContacts": .bool(true), "denial": .string("identityUnresolved"), "failure": .string("eligibilityChanged")]
private let policyFailure: [String: JSONValue] = ["callId": .string("44444444-4444-4444-8444-444444444444"), "outgoing": .bool(true), "connected": .bool(true), "ended": .bool(false), "onHold": .bool(false), "identity": .string("resolved"), "contactMembership": .string("found"), "contactAccess": .string("full"), "policyAllowsKnownContacts": .bool(false), "policyAllowsUnknownContacts": .bool(true), "denial": .string("knownContactDisallowed"), "failure": .string("eligibilityChanged")]
private let connectingBase: [String: JSONValue] = ["callId": .string("44444444-4444-4444-8444-444444444444"), "outgoing": .bool(true), "connected": .bool(false), "ended": .bool(false), "onHold": .bool(false), "identity": .string("resolved"), "contactMembership": .string("found"), "contactAccess": .string("full"), "policyAllowsKnownContacts": .bool(true), "policyAllowsUnknownContacts": .bool(true)]
private let deniedCallBase: [String: JSONValue] = ["callId": .string("55555555-5555-4555-8555-555555555555"), "outgoing": .bool(false), "connected": .bool(true), "ended": .bool(false), "onHold": .bool(false), "identity": .string("unresolved"), "contactMembership": .null, "contactAccess": .string("full"), "policyAllowsKnownContacts": .bool(true), "policyAllowsUnknownContacts": .bool(true)]
private let deniedCallFailure: [String: JSONValue] = ["callId": .string("55555555-5555-4555-8555-555555555555"), "outgoing": .bool(false), "connected": .bool(true), "ended": .bool(false), "onHold": .bool(false), "identity": .string("unresolved"), "contactMembership": .null, "contactAccess": .string("full"), "policyAllowsKnownContacts": .bool(true), "policyAllowsUnknownContacts": .bool(true), "denial": .string("identityUnresolved")]

private let knownAttemptFrames: [(BridgeEventName, [String: JSONValue])] = [(.callStateChanged, knownBase), (.callIdentityResolved, knownBase), (.recordingAttempted, knownAttempt)]
private let knownVerifiedFrames = knownAttemptFrames + [(.recordingVerified, knownVerified)]
private let knownControlFailureFrames = knownAttemptFrames + [(.recordingFailed, knownControlFailure)]
private let identityInvalidationFrames = knownAttemptFrames + [(.callIdentityUnresolved, unresolvedBase), (.recordingFailed, unresolvedFull)]
private let limitedContactsInvalidationFrames = [(BridgeEventName.callStateChanged, unknownFull), (.callIdentityResolved, unknownFull), (.recordingAttempted, unknownAttempt), (.callIdentityResolved, unknownLimitedBase), (.recordingFailed, unknownLimitedFailure)]
private let deniedContactsInvalidationFrames = [(BridgeEventName.callStateChanged, unknownFull), (.callIdentityResolved, unknownFull), (.recordingAttempted, unknownAttempt), (.callIdentityResolved, unknownDeniedBase), (.recordingFailed, unknownDeniedFailure)]
private let endedInvalidationFrames = knownAttemptFrames + [(.callStateChanged, endedBase), (.callIdentityResolved, endedBase), (.recordingFailed, endedFailure)]
private let exactUnsafeInvalidationFrames = knownAttemptFrames + [(.callIdentityUnresolved, unsafeDeniedBase), (.recordingFailed, unsafeDenied)]
private let policyInvalidationFrames = knownAttemptFrames + [(.recordingFailed, policyFailure)]
private let deniedInitialFrames: [(BridgeEventName, [String: JSONValue])] = [(.callStateChanged, deniedCallBase), (.callIdentityUnresolved, deniedCallBase), (.recordingFailed, deniedCallFailure)]
private let connectingThenKnownVerifiedFrames = [(.callStateChanged, connectingBase)] + knownVerifiedFrames

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

private func assertEvents(_ events: [BridgeEvent], _ expected: [(BridgeEventName, [String: JSONValue])]) {
    #expect(events.count == expected.count)
    for (index, pair) in expected.enumerated() where index < events.count {
        #expect(events[index].seq == index)
        #expect(events[index].event == pair.0)
        #expect(events[index].payload == pair.1)
    }
}
