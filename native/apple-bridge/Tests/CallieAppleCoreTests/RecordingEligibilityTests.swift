import Foundation
import Testing
@testable import CallieAppleCore

@Suite("RecordingEligibilityTests")
struct RecordingEligibilityTests {
    @Test func unresolvedIncomingCallNeverRecords() {
        let decision = RecordingEligibility.evaluate(
            call: incomingCall,
            identity: .unresolved,
            contactAccess: .full,
            policy: allowKnownAndUnknown
        )

        #expect(decision == .deny(.identityUnresolved))
    }

    @Test func ambiguousIdentityNeverRecords() {
        #expect(RecordingEligibility.evaluate(
            call: incomingCall,
            identity: .ambiguous,
            contactAccess: .full,
            policy: allowKnownAndUnknown
        ) == .deny(.identityAmbiguous))
    }

    @Test func limitedDeniedRestrictedAndNotDeterminedContactsCannotProveUnknown() {
        for access in [ContactAccess.limited, .denied, .restricted, .notDetermined] {
            #expect(RecordingEligibility.evaluate(
                call: incomingCall,
                identity: .resolved(unknownHandle, contactMembership: .notFound),
                contactAccess: access,
                policy: allowKnownAndUnknown
            ) == .deny(.fullContactsRequired))
        }
    }

    @Test func fullContactsCanSafelyClassifyUnknownWhenPolicyAllowsIt() {
        #expect(RecordingEligibility.evaluate(
            call: incomingCall,
            identity: .resolved(unknownHandle, contactMembership: .notFound),
            contactAccess: .full,
            policy: allowKnownAndUnknown
        ) == .allow(.unknownContact))
    }

    @Test func knownOutgoingCallAllowsWhenPolicyAllowsKnownContacts() {
        #expect(RecordingEligibility.evaluate(
            call: outgoingCall,
            identity: .resolved(knownHandle, contactMembership: .found),
            contactAccess: .denied,
            policy: allowKnownAndUnknown
        ) == .allow(.knownContact))
    }

    @Test func exclusionsUseTheRequiredPriorityOrder() {
        let policy = RecordingPolicySnapshot(
            neverRecordHandles: [neverRecordHandle],
            emergencyHandles: [neverRecordHandle],
            shortCodeHandles: [neverRecordHandle],
            voicemailHandles: [neverRecordHandle],
            allowsKnownContacts: true,
            allowsUnknownContacts: true
        )
        #expect(RecordingEligibility.evaluate(
            call: outgoingCall,
            identity: .resolved(neverRecordHandle, contactMembership: .found),
            contactAccess: .full,
            policy: policy
        ) == .deny(.neverRecord))

        #expect(RecordingEligibility.evaluate(
            call: outgoingCall,
            identity: .resolved(emergencyHandle, contactMembership: .found),
            contactAccess: .full,
            policy: .init(
                emergencyHandles: [emergencyHandle],
                shortCodeHandles: [emergencyHandle],
                voicemailHandles: [emergencyHandle],
                allowsKnownContacts: true,
                allowsUnknownContacts: true
            )
        ) == .deny(.emergencyNumber))

        #expect(RecordingEligibility.evaluate(
            call: outgoingCall,
            identity: .resolved(shortCodeHandle, contactMembership: .found),
            contactAccess: .full,
            policy: .init(shortCodeHandles: [shortCodeHandle], voicemailHandles: [shortCodeHandle], allowsKnownContacts: true, allowsUnknownContacts: true)
        ) == .deny(.shortCode))

        #expect(RecordingEligibility.evaluate(
            call: outgoingCall,
            identity: .resolved(voicemailHandle, contactMembership: .found),
            contactAccess: .full,
            policy: .init(voicemailHandles: [voicemailHandle], allowsKnownContacts: true, allowsUnknownContacts: true)
        ) == .deny(.voicemail))
    }

    @Test func policyCanDenyKnownAndUnknownCallsAfterSafetyChecks() {
        #expect(RecordingEligibility.evaluate(
            call: outgoingCall,
            identity: .resolved(knownHandle, contactMembership: .found),
            contactAccess: .full,
            policy: .init(allowsKnownContacts: false, allowsUnknownContacts: true)
        ) == .deny(.knownContactDisallowed))

        #expect(RecordingEligibility.evaluate(
            call: incomingCall,
            identity: .resolved(unknownHandle, contactMembership: .notFound),
            contactAccess: .full,
            policy: .init(allowsKnownContacts: true, allowsUnknownContacts: false)
        ) == .deny(.unknownContactDisallowed))
    }
}

private let knownHandle = NormalizedHandle("known-synthetic")
private let unknownHandle = NormalizedHandle("unknown-synthetic")
private let neverRecordHandle = NormalizedHandle("never-record-synthetic")
private let emergencyHandle = NormalizedHandle("emergency-synthetic")
private let shortCodeHandle = NormalizedHandle("short-code-synthetic")
private let voicemailHandle = NormalizedHandle("voicemail-synthetic")
private let outgoingCall = ObservedCall(id: UUID(uuidString: "11111111-1111-4111-8111-111111111111")!, outgoing: true, connected: true, ended: false, onHold: false)
private let incomingCall = ObservedCall(id: UUID(uuidString: "22222222-2222-4222-8222-222222222222")!, outgoing: false, connected: true, ended: false, onHold: false)
private let allowKnownAndUnknown = RecordingPolicySnapshot(allowsKnownContacts: true, allowsUnknownContacts: true)
