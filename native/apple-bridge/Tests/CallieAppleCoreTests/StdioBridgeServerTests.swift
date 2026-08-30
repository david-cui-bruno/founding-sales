import Foundation
import Testing
@testable import CallieAppleBridge
@testable import CallieAppleCore
import CallieAppleProtocol

@Test func serverRequiresHelloBeforeCapabilityProbe() async throws {
    let handler = FakeBridgeHandler()
    let server = StdioBridgeServer(handler: handler)
    let response = try await server.processLine(capabilityProbeFixture)

    #expect(response.error?.code == .protocolMismatch)
    #expect(handler.received.isEmpty)
}

@Test func serverRejectsHelloAfterHandshake() async throws {
    let handler = FakeBridgeHandler()
    let server = StdioBridgeServer(handler: handler)
    _ = try await server.processLine(helloFixture(id: "11111111-1111-4111-8111-111111111111"))

    let response = try await server.processLine(helloFixture(id: "22222222-2222-4222-8222-222222222222"))

    #expect(response.error?.code == .invalidRequest)
    #expect(handler.received.count == 1)
}

private let capabilityProbeFixture = Data("""
{"v":1,"kind":"request","id":"11111111-1111-4111-8111-111111111111","method":"capabilities.probe","params":{}}
""".utf8)

private func helloFixture(id: String) -> Data {
    Data("""
    {"v":1,"kind":"request","id":"\(id)","method":"bridge.hello","params":{"supportedVersions":[1]}}
    """.utf8)
}

private final class FakeBridgeHandler: BridgeCommandHandling, @unchecked Sendable {
    private(set) var received: [BridgeRequest] = []

    func handle(_ request: BridgeRequest) -> BridgeResponse {
        received.append(request)
        return BridgeResponse(id: request.id, result: [:])
    }
}
