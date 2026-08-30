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

@Test func serverAwaitsHandlersSequentiallyAcrossConcurrentCallers() async throws {
    let handler = SequencedAsyncBridgeHandler()
    let server = StdioBridgeServer(handler: handler)
    _ = try await server.processLine(helloFixture(id: "11111111-1111-4111-8111-111111111111"))

    async let first = server.processLine(requestFixture(
        id: "22222222-2222-4222-8222-222222222222",
        method: "capabilities.probe"
    ))
    await handler.waitUntilProbeIsBlocked()
    async let second = server.processLine(requestFixture(
        id: "33333333-3333-4333-8333-333333333333",
        method: "permissions.promptAccessibility"
    ))
    await handler.releaseProbe()
    _ = try await (first, second)

    #expect(await handler.methods == [.hello, .probeCapabilities, .promptAccessibility])
    #expect(await handler.maximumConcurrentCalls == 1)
}

private let capabilityProbeFixture = Data("""
{"v":1,"kind":"request","id":"11111111-1111-4111-8111-111111111111","method":"capabilities.probe","params":{}}
""".utf8)

private func helloFixture(id: String) -> Data {
    Data("""
    {"v":1,"kind":"request","id":"\(id)","method":"bridge.hello","params":{"supportedVersions":[1]}}
    """.utf8)
}

private func requestFixture(id: String, method: String) -> Data {
    Data("""
    {"v":1,"kind":"request","id":"\(id)","method":"\(method)","params":{}}
    """.utf8)
}

private final class FakeBridgeHandler: BridgeCommandHandling, @unchecked Sendable {
    private(set) var received: [BridgeRequest] = []

    func handle(_ request: BridgeRequest) async -> BridgeResponse {
        received.append(request)
        return BridgeResponse(id: request.id, result: [:])
    }
}

private actor SequencedAsyncBridgeHandler: BridgeCommandHandling {
    private var activeCalls = 0
    private var maximumConcurrency = 0
    private var observedMethods: [BridgeMethod] = []
    private var probeRelease: CheckedContinuation<Void, Never>?
    private var probeBlocked: CheckedContinuation<Void, Never>?
    private var didBlockProbe = false

    var methods: [BridgeMethod] { observedMethods }
    var maximumConcurrentCalls: Int { maximumConcurrency }

    func handle(_ request: BridgeRequest) async -> BridgeResponse {
        activeCalls += 1
        maximumConcurrency = max(maximumConcurrency, activeCalls)
        observedMethods.append(request.method)
        if request.method == .probeCapabilities {
            didBlockProbe = true
            probeBlocked?.resume()
            probeBlocked = nil
            await withCheckedContinuation { probeRelease = $0 }
        }
        activeCalls -= 1
        return BridgeResponse(id: request.id, result: [:])
    }

    func waitUntilProbeIsBlocked() async {
        if didBlockProbe { return }
        await withCheckedContinuation { probeBlocked = $0 }
    }

    func releaseProbe() {
        probeRelease?.resume()
        probeRelease = nil
    }
}
