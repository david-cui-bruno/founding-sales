import Foundation

public enum BridgeMethod: String, Codable, Sendable {
    case hello = "bridge.hello"
    case probeCapabilities = "capabilities.probe"
    case requestContacts = "permissions.requestContacts"
    case promptAccessibility = "permissions.promptAccessibility"
    case startCallObservation = "call.observe.start"
    case stopCallObservation = "call.observe.stop"
    case armOutgoingRecording = "recording.armOutgoing"
    case disarmRecording = "recording.disarm"
    case scanCallRecordings = "notes.scanCallRecordings"
    case exportCallRecording = "notes.exportCallRecording"
    case sendTestMessage = "messages.sendTest"
    case scanTestMessageActivity = "messages.scanTestActivity"
    case shutdown = "bridge.shutdown"
}

public struct EmptyRequestParameters: Codable, Sendable {
    public init() {}

    public init(from decoder: Decoder) throws {
        try decoder.requireOnlyKeys([])
    }
}

public struct HelloRequestParameters: Codable, Sendable {
    public let supportedVersions: [Int]

    public init(supportedVersions: [Int]) throws {
        guard supportedVersions == [AppleBridgeProtocol.version] else {
            throw BridgeFrameConstructionError.invalidParameters
        }
        self.supportedVersions = supportedVersions
    }

    public init(from decoder: Decoder) throws {
        try decoder.requireOnlyKeys(["supportedVersions"])
        let container = try decoder.container(keyedBy: CodingKeys.self)
        supportedVersions = try container.decode([Int].self, forKey: .supportedVersions)
        guard supportedVersions == [AppleBridgeProtocol.version] else {
            throw DecodingError.dataCorruptedError(forKey: .supportedVersions, in: container, debugDescription: "V1 requires [1]")
        }
    }
}

public struct CallIdentifierParameters: Codable, Sendable {
    public let callId: UUID

    public init(callId: UUID) { self.callId = callId }

    public init(from decoder: Decoder) throws {
        try decoder.requireOnlyKeys(["callId"])
        let container = try decoder.container(keyedBy: CodingKeys.self)
        callId = try container.decode(UUID.self, forKey: .callId)
    }
}

public struct ArtifactIdentifierParameters: Codable, Sendable {
    public let artifactId: UUID

    public init(artifactId: UUID) { self.artifactId = artifactId }

    public init(from decoder: Decoder) throws {
        try decoder.requireOnlyKeys(["artifactId"])
        let container = try decoder.container(keyedBy: CodingKeys.self)
        artifactId = try container.decode(UUID.self, forKey: .artifactId)
    }
}

public struct SendTestMessageParameters: Codable, Sendable {
    public static let requiredConfirmation = "I CONSENT TO THIS TEST MESSAGE"

    public let commandId: UUID
    public let recipientHandle: String
    public let body: String
    public let confirmation: String

    public init(commandId: UUID, recipientHandle: String, body: String, confirmation: String) throws {
        guard !recipientHandle.isEmpty && recipientHandle.utf8.count <= 256,
              !body.isEmpty && body.utf8.count <= 4_000,
              confirmation == Self.requiredConfirmation else {
            throw BridgeFrameConstructionError.invalidParameters
        }
        self.commandId = commandId
        self.recipientHandle = recipientHandle
        self.body = body
        self.confirmation = confirmation
    }

    public init(from decoder: Decoder) throws {
        try decoder.requireOnlyKeys(["commandId", "recipientHandle", "body", "confirmation"])
        let container = try decoder.container(keyedBy: CodingKeys.self)
        commandId = try container.decode(UUID.self, forKey: .commandId)
        recipientHandle = try container.decode(String.self, forKey: .recipientHandle)
        body = try container.decode(String.self, forKey: .body)
        confirmation = try container.decode(String.self, forKey: .confirmation)
        guard !recipientHandle.isEmpty && recipientHandle.utf8.count <= 256 else {
            throw DecodingError.dataCorruptedError(forKey: .recipientHandle, in: container, debugDescription: "Invalid recipient handle")
        }
        guard !body.isEmpty && body.utf8.count <= 4_000 else {
            throw DecodingError.dataCorruptedError(forKey: .body, in: container, debugDescription: "Invalid message body")
        }
        guard confirmation == Self.requiredConfirmation else {
            throw DecodingError.dataCorruptedError(forKey: .confirmation, in: container, debugDescription: "Exact manual confirmation is required")
        }
    }
}

public struct ScanTestMessageActivityParameters: Codable, Sendable {
    public let recipientHandle: String

    public init(recipientHandle: String) throws {
        guard !recipientHandle.isEmpty && recipientHandle.utf8.count <= 256 else {
            throw BridgeFrameConstructionError.invalidParameters
        }
        self.recipientHandle = recipientHandle
    }

    public init(from decoder: Decoder) throws {
        try decoder.requireOnlyKeys(["recipientHandle"])
        let container = try decoder.container(keyedBy: CodingKeys.self)
        recipientHandle = try container.decode(String.self, forKey: .recipientHandle)
        guard !recipientHandle.isEmpty && recipientHandle.utf8.count <= 256 else {
            throw DecodingError.dataCorruptedError(forKey: .recipientHandle, in: container, debugDescription: "Invalid recipient handle")
        }
    }
}

public enum BridgeRequestParameters: Codable, Sendable {
    case hello(HelloRequestParameters)
    case probeCapabilities(EmptyRequestParameters)
    case requestContacts(EmptyRequestParameters)
    case promptAccessibility(EmptyRequestParameters)
    case startCallObservation(EmptyRequestParameters)
    case stopCallObservation(EmptyRequestParameters)
    case armOutgoingRecording(CallIdentifierParameters)
    case disarmRecording(CallIdentifierParameters)
    case scanCallRecordings(EmptyRequestParameters)
    case exportCallRecording(ArtifactIdentifierParameters)
    case sendTestMessage(SendTestMessageParameters)
    case scanTestMessageActivity(ScanTestMessageActivityParameters)
    case shutdown(EmptyRequestParameters)

    public var method: BridgeMethod {
        switch self {
        case .hello: .hello
        case .probeCapabilities: .probeCapabilities
        case .requestContacts: .requestContacts
        case .promptAccessibility: .promptAccessibility
        case .startCallObservation: .startCallObservation
        case .stopCallObservation: .stopCallObservation
        case .armOutgoingRecording: .armOutgoingRecording
        case .disarmRecording: .disarmRecording
        case .scanCallRecordings: .scanCallRecordings
        case .exportCallRecording: .exportCallRecording
        case .sendTestMessage: .sendTestMessage
        case .scanTestMessageActivity: .scanTestMessageActivity
        case .shutdown: .shutdown
        }
    }

    fileprivate static func decode(method: BridgeMethod, from decoder: Decoder) throws -> BridgeRequestParameters {
        switch method {
        case .hello: .hello(try HelloRequestParameters(from: decoder))
        case .probeCapabilities: .probeCapabilities(try EmptyRequestParameters(from: decoder))
        case .requestContacts: .requestContacts(try EmptyRequestParameters(from: decoder))
        case .promptAccessibility: .promptAccessibility(try EmptyRequestParameters(from: decoder))
        case .startCallObservation: .startCallObservation(try EmptyRequestParameters(from: decoder))
        case .stopCallObservation: .stopCallObservation(try EmptyRequestParameters(from: decoder))
        case .armOutgoingRecording: .armOutgoingRecording(try CallIdentifierParameters(from: decoder))
        case .disarmRecording: .disarmRecording(try CallIdentifierParameters(from: decoder))
        case .scanCallRecordings: .scanCallRecordings(try EmptyRequestParameters(from: decoder))
        case .exportCallRecording: .exportCallRecording(try ArtifactIdentifierParameters(from: decoder))
        case .sendTestMessage: .sendTestMessage(try SendTestMessageParameters(from: decoder))
        case .scanTestMessageActivity: .scanTestMessageActivity(try ScanTestMessageActivityParameters(from: decoder))
        case .shutdown: .shutdown(try EmptyRequestParameters(from: decoder))
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case let .hello(value): try value.encode(to: encoder)
        case let .probeCapabilities(value): try value.encode(to: encoder)
        case let .requestContacts(value): try value.encode(to: encoder)
        case let .promptAccessibility(value): try value.encode(to: encoder)
        case let .startCallObservation(value): try value.encode(to: encoder)
        case let .stopCallObservation(value): try value.encode(to: encoder)
        case let .armOutgoingRecording(value): try value.encode(to: encoder)
        case let .disarmRecording(value): try value.encode(to: encoder)
        case let .scanCallRecordings(value): try value.encode(to: encoder)
        case let .exportCallRecording(value): try value.encode(to: encoder)
        case let .sendTestMessage(value): try value.encode(to: encoder)
        case let .scanTestMessageActivity(value): try value.encode(to: encoder)
        case let .shutdown(value): try value.encode(to: encoder)
        }
    }
}

public struct BridgeRequest: Codable, Sendable {
    public let v: Int
    public let id: UUID
    public let method: BridgeMethod
    public let params: BridgeRequestParameters

    enum CodingKeys: String, CodingKey { case v, kind, id, method, params }

    public init(id: UUID, method: BridgeMethod, params: BridgeRequestParameters) throws {
        guard method == params.method else {
            throw BridgeFrameConstructionError.mismatchedRequestParameters
        }
        if case let .sendTestMessage(parameters) = params, parameters.commandId == id {
            throw BridgeFrameConstructionError.invalidParameters
        }
        v = AppleBridgeProtocol.version
        self.id = id
        self.method = method
        self.params = params
    }

    public init(from decoder: Decoder) throws {
        try decoder.requireOnlyKeys(["v", "kind", "id", "method", "params"])
        let container = try decoder.container(keyedBy: CodingKeys.self)
        v = try container.decode(Int.self, forKey: .v)
        guard v == AppleBridgeProtocol.version else {
            throw DecodingError.dataCorruptedError(forKey: .v, in: container, debugDescription: "Unsupported protocol version")
        }
        guard try container.decode(BridgeEnvelopeKind.self, forKey: .kind) == .request else {
            throw DecodingError.dataCorruptedError(forKey: .kind, in: container, debugDescription: "Expected request envelope")
        }
        id = try container.decode(UUID.self, forKey: .id)
        method = try container.decode(BridgeMethod.self, forKey: .method)
        params = try BridgeRequestParameters.decode(method: method, from: container.superDecoder(forKey: .params))
        if case let .sendTestMessage(parameters) = params, parameters.commandId == id {
            throw DecodingError.dataCorruptedError(forKey: .params, in: container, debugDescription: "Command ID must differ from request ID")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(v, forKey: .v)
        try container.encode(BridgeEnvelopeKind.request, forKey: .kind)
        try container.encode(id, forKey: .id)
        try container.encode(method, forKey: .method)
        try params.encode(to: container.superEncoder(forKey: .params))
    }
}
