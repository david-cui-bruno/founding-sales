import Foundation

public enum BridgeEventName: String, Codable, Sendable {
    case ready = "bridge.ready"
    case capabilityChanged = "capability.changed"
    case callStateChanged = "call.stateChanged"
    case callIdentityResolved = "call.identityResolved"
    case callIdentityUnresolved = "call.identityUnresolved"
    case recordingAttempted = "recording.attempted"
    case recordingVerified = "recording.verified"
    case recordingFailed = "recording.failed"
    case notesArtifactDiscovered = "notes.artifactDiscovered"
    case notesExportCompleted = "notes.exportCompleted"
    case notesTranscriptUnavailable = "notes.transcriptUnavailable"
    case messagesActivityObserved = "messages.activityObserved"
    case warning = "bridge.warning"
}

public struct BridgeEvent: Codable, Sendable {
    public let v: Int
    public let seq: Int
    public let event: BridgeEventName
    public let payload: [String: JSONValue]

    enum CodingKeys: String, CodingKey { case v, kind, seq, event, payload }

    public init(from decoder: Decoder) throws {
        try decoder.requireOnlyKeys(["v", "kind", "seq", "event", "payload"])
        let container = try decoder.container(keyedBy: CodingKeys.self)
        v = try container.decode(Int.self, forKey: .v)
        guard v == AppleBridgeProtocol.version else {
            throw DecodingError.dataCorruptedError(forKey: .v, in: container, debugDescription: "Unsupported protocol version")
        }
        guard try container.decode(BridgeEnvelopeKind.self, forKey: .kind) == .event else {
            throw DecodingError.dataCorruptedError(forKey: .kind, in: container, debugDescription: "Expected event envelope")
        }
        seq = try container.decode(Int.self, forKey: .seq)
        guard seq >= 0 else {
            throw DecodingError.dataCorruptedError(forKey: .seq, in: container, debugDescription: "Negative event sequence")
        }
        event = try container.decode(BridgeEventName.self, forKey: .event)
        payload = try container.decode([String: JSONValue].self, forKey: .payload)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(v, forKey: .v)
        try container.encode(BridgeEnvelopeKind.event, forKey: .kind)
        try container.encode(seq, forKey: .seq)
        try container.encode(event, forKey: .event)
        try container.encode(payload, forKey: .payload)
    }
}
