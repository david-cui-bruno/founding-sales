import Foundation

public enum BridgeErrorCode: String, Codable, Sendable {
    case protocolMismatch = "protocol_mismatch"
    case invalidRequest = "invalid_request"
    case permissionDenied = "permission_denied"
    case capabilityUnavailable = "capability_unavailable"
    case identityUnresolved = "identity_unresolved"
    case controlNotFound = "control_not_found"
    case recordingVerificationFailed = "recording_verification_failed"
    case artifactNotFound = "artifact_not_found"
    case schemaUnsupported = "schema_unsupported"
    case timeout
    case internalError = "internal"
}

public struct BridgeErrorPayload: Codable, Sendable {
    public let code: BridgeErrorCode
    public let message: String
    public let retryable: Bool

    public init(code: BridgeErrorCode, message: String, retryable: Bool) throws {
        guard !message.isEmpty && message.count <= 300 else {
            throw BridgeFrameConstructionError.invalidParameters
        }
        self.code = code
        self.message = message
        self.retryable = retryable
    }

    public init(from decoder: Decoder) throws {
        try decoder.requireOnlyKeys(["code", "message", "retryable"])
        let container = try decoder.container(keyedBy: CodingKeys.self)
        code = try container.decode(BridgeErrorCode.self, forKey: .code)
        message = try container.decode(String.self, forKey: .message)
        retryable = try container.decode(Bool.self, forKey: .retryable)
        guard !message.isEmpty && message.count <= 300 else {
            throw DecodingError.dataCorruptedError(forKey: .message, in: container, debugDescription: "Invalid error message")
        }
    }
}

public struct BridgeResponse: Codable, Sendable {
    public let v: Int
    public let id: UUID
    public let ok: Bool
    public let result: [String: JSONValue]?
    public let error: BridgeErrorPayload?

    enum CodingKeys: String, CodingKey { case v, kind, id, ok, result, error }

    public init(id: UUID, result: [String: JSONValue]) {
        v = AppleBridgeProtocol.version
        self.id = id
        ok = true
        self.result = result
        error = nil
    }

    public init(id: UUID, error: BridgeErrorPayload) {
        v = AppleBridgeProtocol.version
        self.id = id
        ok = false
        result = nil
        self.error = error
    }

    public init(from decoder: Decoder) throws {
        try decoder.requireOnlyKeys(["v", "kind", "id", "ok", "result", "error"])
        let container = try decoder.container(keyedBy: CodingKeys.self)
        v = try container.decode(Int.self, forKey: .v)
        guard v == AppleBridgeProtocol.version else {
            throw DecodingError.dataCorruptedError(forKey: .v, in: container, debugDescription: "Unsupported protocol version")
        }
        guard try container.decode(BridgeEnvelopeKind.self, forKey: .kind) == .response else {
            throw DecodingError.dataCorruptedError(forKey: .kind, in: container, debugDescription: "Expected response envelope")
        }
        id = try container.decode(UUID.self, forKey: .id)
        ok = try container.decode(Bool.self, forKey: .ok)
        result = try container.decodeIfPresent([String: JSONValue].self, forKey: .result)
        error = try container.decodeIfPresent(BridgeErrorPayload.self, forKey: .error)
        guard (ok && result != nil && error == nil) || (!ok && result == nil && error != nil) else {
            throw DecodingError.dataCorruptedError(forKey: .ok, in: container, debugDescription: "Invalid response branch")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(v, forKey: .v)
        try container.encode(BridgeEnvelopeKind.response, forKey: .kind)
        try container.encode(id, forKey: .id)
        try container.encode(ok, forKey: .ok)
        if ok { try container.encode(result, forKey: .result) } else { try container.encode(error, forKey: .error) }
    }
}
