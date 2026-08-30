import CallieAppleProtocol
import Foundation

public actor BridgeCoordinator: BridgeCommandHandling {
    private let policy: RecordingPolicySnapshot
    private let recordingController: any RecordingControlling
    private let eventSink: @Sendable (BridgeEvent) -> Void
    private var sessions: [UUID: CallSessionStateMachine] = [:]
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

    public func observe(
        _ call: ObservedCall,
        identity: IdentityResolution,
        contactAccess: ContactAccess
    ) async {
        if var existing = sessions[call.id] {
            guard existing.apply(.observed(call)) else { return }
            sessions[call.id] = existing
            emit(.callStateChanged, call: call)
        } else {
            sessions[call.id] = CallSessionStateMachine(call: call)
            emit(.callStateChanged, call: call)
        }

        guard call.connected, !call.ended, !call.onHold else { return }
        guard var session = sessions[call.id], session.recordingState == .idle else { return }
        switch identity {
        case .unresolved:
            emit(.callIdentityUnresolved, call: call)
        case .ambiguous:
            emit(.callIdentityUnresolved, call: call)
        case .resolved:
            emit(.callIdentityResolved, call: call)
        }

        let decision = RecordingEligibility.evaluate(
            call: call,
            identity: identity,
            contactAccess: contactAccess,
            policy: policy
        )
        guard case .allow = decision else {
            emit(.recordingFailed, call: call)
            return
        }
        guard session.apply(.recordingAttempted(at: Date())) else { return }
        sessions[call.id] = session
        emit(.recordingAttempted, call: call)

        let verification: RecordingVerification
        do {
            verification = try await recordingController.attemptStart(for: call)
        } catch {
            verification = .failed(.controllerError)
        }

        guard var latestSession = sessions[call.id], latestSession.call == call else { return }
        switch verification {
        case .verified:
            guard latestSession.apply(.recordingVerified(at: Date())) else { return }
            sessions[call.id] = latestSession
            emit(.recordingVerified, call: call)
        case let .failed(failure):
            guard latestSession.apply(.recordingVerificationFailed(failure)) else { return }
            sessions[call.id] = latestSession
            emit(.recordingFailed, call: call)
        }
    }

    private func emit(_ name: BridgeEventName, call: ObservedCall) {
        defer { nextSequence += 1 }
        guard let event = try? BridgeEvent(
            seq: nextSequence,
            event: name,
            payload: ["callId": .string(call.id.uuidString.lowercased())]
        ) else {
            return
        }
        eventSink(event)
    }
}
