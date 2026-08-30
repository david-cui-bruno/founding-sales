import Foundation
import Testing
@testable import CallieAppleCore

@Suite("CallSessionStateMachineTests")
struct CallSessionStateMachineTests {
    @Test func attemptedRecordingIsNotVerifiedRecording() {
        var state = CallSessionStateMachine(call: connectedOutgoingCall)

        let didAttempt = state.apply(.recordingAttempted(at: fixtureDate))
        #expect(didAttempt)
        #expect(state.recordingState == .attempted)
        let didFailVerification = state.apply(.recordingVerificationFailed(.controlNotFound))
        #expect(didFailVerification)
        #expect(state.recordingState == .failed(.controlNotFound))
    }

    @Test func duplicateObservedCallsAndDuplicateTransitionsAreNoOps() {
        var state = CallSessionStateMachine(call: connectedOutgoingCall)

        let ignoredObservation = state.apply(.observed(connectedOutgoingCall))
        #expect(!ignoredObservation)
        let didAttempt = state.apply(.recordingAttempted(at: fixtureDate))
        #expect(didAttempt)
        let ignoredAttempt = state.apply(.recordingAttempted(at: fixtureDate))
        #expect(!ignoredAttempt)
        let didVerify = state.apply(.recordingVerified(at: fixtureDate))
        #expect(didVerify)
        let ignoredVerification = state.apply(.recordingVerified(at: fixtureDate))
        #expect(!ignoredVerification)
        #expect(state.recordingState == .verified)
    }

    @Test func endedCallCannotTransitionToVerifiedRecording() {
        var state = CallSessionStateMachine(call: connectedOutgoingCall)
        let ended = ObservedCall(id: connectedOutgoingCall.id, outgoing: true, connected: true, ended: true, onHold: false)

        let didAttempt = state.apply(.recordingAttempted(at: fixtureDate))
        #expect(didAttempt)
        let didEnd = state.apply(.observed(ended))
        #expect(didEnd)
        #expect(state.callState == .ended)
        #expect(state.recordingState == .failed(.callEnded))
        let ignoredVerification = state.apply(.recordingVerified(at: fixtureDate))
        #expect(!ignoredVerification)
        #expect(state.recordingState == .failed(.callEnded))
    }

    @Test func endedCallCannotReopenFromAStaleObservation() {
        var state = CallSessionStateMachine(call: connectedOutgoingCall)
        let ended = ObservedCall(id: connectedOutgoingCall.id, outgoing: true, connected: true, ended: true, onHold: false)

        let didEnd = state.apply(.observed(ended))
        #expect(didEnd)
        let didReopen = state.apply(.observed(connectedOutgoingCall))

        #expect(!didReopen)
        #expect(state.callState == .ended)
        #expect(state.call == ended)
    }
}

private let connectedOutgoingCall = ObservedCall(id: UUID(uuidString: "33333333-3333-4333-8333-333333333333")!, outgoing: true, connected: true, ended: false, onHold: false)
private let fixtureDate = Date(timeIntervalSinceReferenceDate: 1)
