import Foundation
import Testing
import CallieAppleProtocol

@Test func publicFramesCanBeConstructedAndEncoded() throws {
    let id = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
    let request = try BridgeRequest(
        id: id,
        method: .hello,
        params: .hello(try HelloRequestParameters(supportedVersions: [1]))
    )
    let success = BridgeResponse(id: id, result: ["selectedVersion": .number(1)])
    let failure = BridgeResponse(
        id: id,
        error: try BridgeErrorPayload(code: .protocolMismatch, message: "Protocol V1 handshake is required.", retryable: false)
    )
    let event = try BridgeEvent(seq: 0, event: .ready, payload: [:])
    let encoder = JSONEncoder()

    for frame in [
        try encoder.encode(request),
        try encoder.encode(success),
        try encoder.encode(failure),
        try encoder.encode(event),
    ] {
        let object = try JSONSerialization.jsonObject(with: frame) as? [String: Any]
        #expect(object?["v"] as? Int == 1)
        #expect(object?["kind"] as? String != nil)
    }
}
