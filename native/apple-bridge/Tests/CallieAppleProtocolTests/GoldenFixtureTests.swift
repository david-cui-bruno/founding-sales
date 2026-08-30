import Foundation
import Testing
@testable import CallieAppleProtocol

@Test func decodesGoldenHelloRequest() throws {
    let root = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent()
    let data = try Data(contentsOf: root.appending(path: "contracts/apple-bridge/v1/fixtures/hello.request.json"))
    let request = try JSONDecoder().decode(BridgeRequest.self, from: data)
    #expect(request.v == 1)
    #expect(request.method == .hello)
}

@Test func decodesAllGoldenFixturesAndRejectsUnknownMethod() throws {
    let root = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent()
    let fixtures = root.appending(path: "contracts/apple-bridge/v1/fixtures")
    let decoder = JSONDecoder()

    #expect(try decoder.decode(BridgeResponse.self, from: Data(contentsOf: fixtures.appending(path: "hello.response.json"))).ok)
    #expect(try decoder.decode(BridgeRequest.self, from: Data(contentsOf: fixtures.appending(path: "messages-send.request.json"))).method == .sendTestMessage)
    #expect(try decoder.decode(BridgeEvent.self, from: Data(contentsOf: fixtures.appending(path: "call-connected.event.json"))).event == .callStateChanged)
    #expect(try decoder.decode(BridgeEvent.self, from: Data(contentsOf: fixtures.appending(path: "recording-failed.event.json"))).event == .recordingFailed)
    #expect(!(try decoder.decode(BridgeResponse.self, from: Data(contentsOf: fixtures.appending(path: "error.response.json"))).ok))

    let arbitraryCommand = Data("{\"v\":1,\"kind\":\"request\",\"id\":\"11111111-1111-4111-8111-111111111111\",\"method\":\"shell.execute\",\"params\":{\"path\":\"/tmp/output\"}}".utf8)
    #expect(throws: DecodingError.self) {
        try decoder.decode(BridgeRequest.self, from: arbitraryCommand)
    }
}
