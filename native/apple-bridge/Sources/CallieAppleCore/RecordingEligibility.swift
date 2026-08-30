import Foundation

public struct NormalizedHandle: Sendable, Equatable, Hashable {
    public let value: String

    public init(_ value: String) {
        self.value = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

public enum ContactMembership: Sendable, Equatable {
    case found
    case notFound
}

public enum IdentityResolution: Sendable, Equatable {
    case resolved(NormalizedHandle, contactMembership: ContactMembership)
    case ambiguous
    case unresolved
}

public struct RecordingPolicySnapshot: Sendable, Equatable {
    public let neverRecordHandles: Set<NormalizedHandle>
    public let emergencyHandles: Set<NormalizedHandle>
    public let shortCodeHandles: Set<NormalizedHandle>
    public let voicemailHandles: Set<NormalizedHandle>
    public let allowsKnownContacts: Bool
    public let allowsUnknownContacts: Bool

    public init(
        neverRecordHandles: Set<NormalizedHandle> = [],
        emergencyHandles: Set<NormalizedHandle> = [],
        shortCodeHandles: Set<NormalizedHandle> = [],
        voicemailHandles: Set<NormalizedHandle> = [],
        allowsKnownContacts: Bool,
        allowsUnknownContacts: Bool
    ) {
        self.neverRecordHandles = neverRecordHandles
        self.emergencyHandles = emergencyHandles
        self.shortCodeHandles = shortCodeHandles
        self.voicemailHandles = voicemailHandles
        self.allowsKnownContacts = allowsKnownContacts
        self.allowsUnknownContacts = allowsUnknownContacts
    }
}

public enum RecordingReason: Sendable, Equatable {
    case knownContact
    case unknownContact
}

public enum RecordingDenial: Sendable, Equatable {
    case neverRecord
    case emergencyNumber
    case shortCode
    case voicemail
    case identityUnresolved
    case identityAmbiguous
    case fullContactsRequired
    case knownContactDisallowed
    case unknownContactDisallowed
    case callNotRecordable
}

public enum RecordingDecision: Sendable, Equatable {
    case allow(RecordingReason)
    case deny(RecordingDenial)
}

public enum RecordingEligibility {
    public static func evaluate(
        call: ObservedCall,
        identity: IdentityResolution,
        contactAccess: ContactAccess,
        policy: RecordingPolicySnapshot
    ) -> RecordingDecision {
        let resolvedHandle: NormalizedHandle?
        let membership: ContactMembership?
        switch identity {
        case let .resolved(handle, contactMembership):
            resolvedHandle = handle
            membership = contactMembership
        case .ambiguous, .unresolved:
            resolvedHandle = nil
            membership = nil
        }

        // Exclusions are intentionally ordered. Never alter this sequence without a
        // corresponding safety review: the first matching denial is the audit reason.
        if let resolvedHandle, policy.neverRecordHandles.contains(resolvedHandle) {
            return .deny(.neverRecord)
        }
        if let resolvedHandle, policy.emergencyHandles.contains(resolvedHandle) {
            return .deny(.emergencyNumber)
        }
        if let resolvedHandle, policy.shortCodeHandles.contains(resolvedHandle) {
            return .deny(.shortCode)
        }
        if let resolvedHandle, policy.voicemailHandles.contains(resolvedHandle) {
            return .deny(.voicemail)
        }
        switch identity {
        case .unresolved:
            return .deny(.identityUnresolved)
        case .ambiguous:
            return .deny(.identityAmbiguous)
        case .resolved:
            break
        }
        guard let membership else {
            return .deny(.identityUnresolved)
        }
        if membership == .notFound, contactAccess != .full {
            return .deny(.fullContactsRequired)
        }
        guard call.connected, !call.ended, !call.onHold else {
            return .deny(.callNotRecordable)
        }
        switch membership {
        case .found:
            return policy.allowsKnownContacts ? .allow(.knownContact) : .deny(.knownContactDisallowed)
        case .notFound:
            return policy.allowsUnknownContacts ? .allow(.unknownContact) : .deny(.unknownContactDisallowed)
        }
    }
}
