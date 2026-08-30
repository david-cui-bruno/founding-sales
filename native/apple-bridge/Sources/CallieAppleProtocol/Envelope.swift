import Foundation

enum BridgeEnvelopeKind: String, Codable, Sendable {
    case request
    case response
    case event
}

struct AnyCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int?

    init?(stringValue: String) { self.stringValue = stringValue; intValue = nil }
    init?(intValue: Int) { self.stringValue = "\(intValue)"; self.intValue = intValue }
}

extension Decoder {
    func requireOnlyKeys(_ allowed: Set<String>) throws {
        let container = try self.container(keyedBy: AnyCodingKey.self)
        guard Set(container.allKeys.map(\.stringValue)).isSubset(of: allowed) else {
            throw DecodingError.dataCorrupted(.init(codingPath: codingPath, debugDescription: "Unexpected protocol fields"))
        }
    }
}

public enum JSONValue: Codable, Sendable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        if let value = try? decoder.singleValueContainer().decode(String.self) { self = .string(value) }
        else if let value = try? decoder.singleValueContainer().decode(Bool.self) { self = .bool(value) }
        else if let value = try? decoder.singleValueContainer().decode(Double.self) { self = .number(value) }
        else if let value = try? decoder.singleValueContainer().decode([String: JSONValue].self) { self = .object(value) }
        else if let value = try? decoder.singleValueContainer().decode([JSONValue].self) { self = .array(value) }
        else if try decoder.singleValueContainer().decodeNil() { self = .null }
        else { throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unsupported JSON value")) }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .string(value): try container.encode(value)
        case let .number(value): try container.encode(value)
        case let .bool(value): try container.encode(value)
        case let .object(value): try container.encode(value)
        case let .array(value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}
