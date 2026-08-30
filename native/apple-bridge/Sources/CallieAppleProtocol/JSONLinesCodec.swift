import Foundation

public enum JSONLinesCodecError: Error, Equatable, Sendable {
    case frameTooLarge
    case invalidUTF8
}

public struct JSONLinesCodec: Sendable {
    public let maxFrameBytes: Int

    public init(maxFrameBytes: Int = AppleBridgeProtocol.maximumFrameBytes) {
        self.maxFrameBytes = maxFrameBytes
    }

    public func decodeLine(_ data: Data) throws -> BridgeRequest {
        guard data.count <= maxFrameBytes else {
            throw JSONLinesCodecError.frameTooLarge
        }
        guard String(data: data, encoding: .utf8) != nil else {
            throw JSONLinesCodecError.invalidUTF8
        }
        return try JSONDecoder().decode(BridgeRequest.self, from: data)
    }

    public func encodeLine<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        let encoded = try encoder.encode(value)
        guard encoded.count < maxFrameBytes else {
            throw JSONLinesCodecError.frameTooLarge
        }
        return encoded + Data([0x0A])
    }
}
