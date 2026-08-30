import Foundation

public protocol CallObserving: Sendable {
    func start(_ sink: @escaping @Sendable (ObservedCall) -> Void) throws
    func stop()
}

public enum RecordingFailure: Sendable, Equatable {
    case controlNotFound
    case verificationFailed
    case callEnded
    case eligibilityChanged
    case controllerError
}

public enum RecordingVerification: Sendable, Equatable {
    case verified
    case failed(RecordingFailure)
}

public protocol RecordingControlling: Sendable {
    func attemptStart(for call: ObservedCall) async throws -> RecordingVerification
}

public protocol CapabilityProbing: Sendable {
    func probe() -> CapabilityStatus
}

public struct NotesArtifactID: Sendable, Equatable, Hashable {
    public let value: UUID

    public init(_ value: UUID) {
        self.value = value
    }
}

public struct NotesRecordingArtifact: Sendable, Equatable {
    public let id: NotesArtifactID
    public let createdAt: Date

    public init(id: NotesArtifactID, createdAt: Date) {
        self.id = id
        self.createdAt = createdAt
    }
}

public struct ExportProof: Sendable, Equatable {
    public let artifactID: NotesArtifactID
    public let byteCount: Int64
    public let sha256: String
    public let plaintextRetained: Bool

    public init(artifactID: NotesArtifactID, byteCount: Int64, sha256: String, plaintextRetained: Bool) {
        self.artifactID = artifactID
        self.byteCount = byteCount
        self.sha256 = sha256
        self.plaintextRetained = plaintextRetained
    }
}

public struct ManualMessageTest: Sendable, Equatable {
    public static let requiredConfirmation = "I CONSENT TO THIS TEST MESSAGE"

    public let commandID: UUID
    public let handle: NormalizedHandle
    public let body: String
    public let confirmation: String

    public init(commandID: UUID, handle: NormalizedHandle, body: String, confirmation: String) {
        self.commandID = commandID
        self.handle = handle
        self.body = body
        self.confirmation = confirmation
    }
}

public struct MessageSendReceipt: Sendable, Equatable {
    public let commandID: UUID

    public init(commandID: UUID) {
        self.commandID = commandID
    }
}

public struct MessageTestActivity: Sendable, Equatable {
    public let sentCount: Int
    public let receivedCount: Int
    public let latestAt: Date?

    public init(sentCount: Int, receivedCount: Int, latestAt: Date?) {
        self.sentCount = sentCount
        self.receivedCount = receivedCount
        self.latestAt = latestAt
    }
}

public enum NotesPortError: Error, Sendable, Equatable {
    case artifactNotFound
    case capabilityUnavailable
    case invalidReply
    case exportFailed
    case cleanupFailed
}

public enum MessagesSendPortError: Error, Sendable, Equatable {
    case manualConfirmationRequired
    case invalidRequest
    case sendFailed
}

public enum MessagesReadPortError: Error, Sendable, Equatable {
    case schemaUnsupported
    case databaseUnavailable
    case queryFailed
}

public protocol NotesRecordingScanning: Sendable {
    func scan(since: Date) throws -> [NotesRecordingArtifact]
}

public protocol NotesAttachmentExporting: Sendable {
    func proveExport(id: NotesArtifactID) throws -> ExportProof
}

public protocol MessageTestSending: Sendable {
    func sendTest(_ test: ManualMessageTest) throws -> MessageSendReceipt
}

public protocol MessageTestActivityScanning: Sendable {
    func scanTestActivity(handle: NormalizedHandle, since: Date) throws -> MessageTestActivity
}
