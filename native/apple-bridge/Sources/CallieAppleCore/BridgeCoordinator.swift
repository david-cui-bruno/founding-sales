import CallieAppleProtocol
import Foundation

public actor BridgeCoordinator: BridgeCommandHandling {
    private struct SafetySnapshot: Sendable, Equatable {
        let call: ObservedCall
        let identity: IdentityResolution
        let contactAccess: ContactAccess
        let policy: RecordingPolicySnapshot
    }

    private struct Session: Sendable, Equatable {
        var stateMachine: CallSessionStateMachine
        var safety: SafetySnapshot
        var generation: Int
    }

    private var policy: RecordingPolicySnapshot
    private let recordingController: any RecordingControlling
    private let eventSink: @Sendable (BridgeEvent) -> Void
    private var sessions: [UUID: Session] = [:]
    private var nextSequence = 0

    public init(
        policy: RecordingPolicySnapshot,
        recordingController: any RecordingControlling,
        eventSink: @escaping @Sendable (BridgeEvent) -> Void = { _ in }
    ) {
        self.policy = policy
        self.recordingController = recordingController
        self.eventSink = eventSink
    }

    /// Keeps Task 2's bounded request behavior intact. Observation and recording
    /// arrive through typed ports, never through an expandable bridge command.
    public nonisolated func handle(_ request: BridgeRequest) -> BridgeResponse {
        BoundedBridgeCommandHandler().handle(request)
    }

    public func recordingState(for callID: UUID) -> RecordingState? {
        sessions[callID]?.stateMachine.recordingState
    }

    public func updatePolicy(_ updatedPolicy: RecordingPolicySnapshot) {
        guard updatedPolicy != policy else { return }
        policy = updatedPolicy
        for callID in sessions.keys {
            guard var session = sessions[callID] else { continue }
            let updatedSafety = SafetySnapshot(
                call: session.safety.call,
                identity: session.safety.identity,
                contactAccess: session.safety.contactAccess,
                policy: updatedPolicy
            )
            guard updatedSafety != session.safety else { continue }
            let wasAttempting = session.stateMachine.recordingState == .attempted
            session.safety = updatedSafety
            session.generation += 1
            sessions[callID] = session
            if wasAttempting {
                invalidateAttempt(for: callID, denial: decision(for: updatedSafety).denial)
            }
        }
    }

    public func observe(
        _ call: ObservedCall,
        identity: IdentityResolution,
        contactAccess: ContactAccess
    ) async {
        if var session = sessions[call.id] {
            let wasAttempting = session.stateMachine.recordingState == .attempted
            let callChanged = session.stateMachine.apply(.observed(call))
            let updatedSafety = SafetySnapshot(
                call: callChanged ? call : session.stateMachine.call,
                identity: identity,
                contactAccess: contactAccess,
                policy: policy
            )
            let safetyChanged = session.safety != updatedSafety
            guard callChanged || safetyChanged else { return }

            session.safety = updatedSafety
            if safetyChanged { session.generation += 1 }
            sessions[call.id] = session
            if callChanged { emit(.callStateChanged, safety: updatedSafety) }
            if safetyChanged, wasAttempting {
                emitIdentityChange(for: updatedSafety)
                invalidateAttempt(for: call.id, denial: decision(for: updatedSafety).denial)
                return
            }
        } else {
            let updatedSafety = SafetySnapshot(call: call, identity: identity, contactAccess: contactAccess, policy: policy)
            sessions[call.id] = Session(
                stateMachine: CallSessionStateMachine(call: call),
                safety: updatedSafety,
                generation: 0
            )
            emit(.callStateChanged, safety: updatedSafety)
        }

        await beginAttemptIfEligible(for: call.id)
    }

    private func beginAttemptIfEligible(for callID: UUID) async {
        guard var session = sessions[callID],
              session.stateMachine.recordingState == .idle,
              session.safety.call.connected,
              !session.safety.call.ended,
              !session.safety.call.onHold else { return }

        emitIdentityChange(for: session.safety)
        let eligibilityDecision = decision(for: session.safety)
        guard case let .allow(reason) = eligibilityDecision else {
            emitRecordingFailed(safety: session.safety, denial: eligibilityDecision.denial)
            return
        }
        guard session.stateMachine.apply(.recordingAttempted(at: Date())) else { return }
        let attemptSafety = session.safety
        let attemptGeneration = session.generation
        sessions[callID] = session
        emit(.recordingAttempted, safety: attemptSafety, extra: ["reason": .string(reason.wireValue)])

        let verification: RecordingVerification
        do {
            verification = try await recordingController.attemptStart(for: attemptSafety.call)
        } catch {
            verification = .failed(.controllerError)
        }

        guard var latestSession = sessions[callID],
              latestSession.generation == attemptGeneration,
              latestSession.safety == attemptSafety,
              latestSession.stateMachine.recordingState == .attempted else { return }
        switch verification {
        case .verified:
            guard latestSession.stateMachine.apply(.recordingVerified(at: Date())) else { return }
            sessions[callID] = latestSession
            emit(.recordingVerified, safety: latestSession.safety, extra: ["verification": .string("verified")])
        case let .failed(failure):
            guard latestSession.stateMachine.apply(.recordingVerificationFailed(failure)) else { return }
            sessions[callID] = latestSession
            emit(.recordingFailed, safety: latestSession.safety, extra: ["failure": .string(failure.wireValue)])
        }
    }

    private func invalidateAttempt(for callID: UUID, denial: RecordingDenial?) {
        guard var session = sessions[callID] else { return }
        if session.stateMachine.recordingState == .attempted {
            _ = session.stateMachine.apply(.recordingVerificationFailed(.eligibilityChanged))
            sessions[callID] = session
        }
        emitRecordingFailed(safety: session.safety, denial: denial)
    }

    private func decision(for safety: SafetySnapshot) -> RecordingDecision {
        RecordingEligibility.evaluate(
            call: safety.call,
            identity: safety.identity,
            contactAccess: safety.contactAccess,
            policy: safety.policy
        )
    }

    private func emitIdentityChange(for safety: SafetySnapshot) {
        switch safety.identity {
        case .resolved:
            emit(.callIdentityResolved, safety: safety)
        case .ambiguous, .unresolved:
            emit(.callIdentityUnresolved, safety: safety)
        }
    }

    private func emitRecordingFailed(safety: SafetySnapshot, denial: RecordingDenial?) {
        var extra: [String: JSONValue] = [:]
        if let denial { extra["denial"] = .string(denial.wireValue) }
        emit(.recordingFailed, safety: safety, extra: extra)
    }

    private func emit(_ name: BridgeEventName, safety: SafetySnapshot, extra: [String: JSONValue] = [:]) {
        defer { nextSequence += 1 }
        var payload: [String: JSONValue] = [
            "callId": .string(safety.call.id.uuidString.lowercased()),
            "outgoing": .bool(safety.call.outgoing),
            "connected": .bool(safety.call.connected),
            "ended": .bool(safety.call.ended),
            "onHold": .bool(safety.call.onHold),
            "identity": .string(safety.identity.wireValue),
            "contactAccess": .string(safety.contactAccess.wireValue),
        ]
        for (key, value) in extra { payload[key] = value }
        guard let event = try? BridgeEvent(seq: nextSequence, event: name, payload: payload) else { return }
        eventSink(event)
    }
}

private extension RecordingDecision {
    var denial: RecordingDenial? {
        guard case let .deny(denial) = self else { return nil }
        return denial
    }
}

private extension RecordingReason {
    var wireValue: String {
        switch self {
        case .knownContact: "knownContact"
        case .unknownContact: "unknownContact"
        }
    }
}

private extension RecordingDenial {
    var wireValue: String {
        switch self {
        case .neverRecord: "neverRecord"
        case .emergencyNumber: "emergencyNumber"
        case .shortCode: "shortCode"
        case .voicemail: "voicemail"
        case .identityUnresolved: "identityUnresolved"
        case .identityAmbiguous: "identityAmbiguous"
        case .fullContactsRequired: "fullContactsRequired"
        case .knownContactDisallowed: "knownContactDisallowed"
        case .unknownContactDisallowed: "unknownContactDisallowed"
        case .callNotRecordable: "callNotRecordable"
        }
    }
}

private extension RecordingFailure {
    var wireValue: String {
        switch self {
        case .controlNotFound: "controlNotFound"
        case .verificationFailed: "verificationFailed"
        case .callEnded: "callEnded"
        case .eligibilityChanged: "eligibilityChanged"
        case .controllerError: "controllerError"
        }
    }
}

private extension ContactAccess {
    var wireValue: String {
        switch self {
        case .full: "full"
        case .limited: "limited"
        case .denied: "denied"
        case .restricted: "restricted"
        case .notDetermined: "notDetermined"
        }
    }
}

private extension IdentityResolution {
    var wireValue: String {
        switch self {
        case .resolved: "resolved"
        case .ambiguous: "ambiguous"
        case .unresolved: "unresolved"
        }
    }
}
