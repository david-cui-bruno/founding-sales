import CallieAppleProtocol
import Foundation
import Testing
@testable import CallieAppleBridge
@testable import CallieAppleCore

@Suite("BridgeFrameWriterTests")
struct BridgeFrameWriterTests {
    @Test func eventsAreDroppedUntilServerAcceptsHello() async throws {
        let output = CapturingDataWriter()
        let diagnostics = CapturingDataWriter()
        let writer = SynchronizedJSONLFrameWriter(output: output, diagnostics: diagnostics)
        let server = StdioBridgeServer(handler: BoundedBridgeCommandHandler(), frameWriter: writer)
        let event = try BridgeEvent(seq: 0, event: .callStateChanged, payload: ["connected": .bool(true)])

        #expect(!writer.emit(event))
        #expect(output.data.isEmpty)

        _ = try await server.processLine(Data("""
        {"v":1,"kind":"request","id":"11111111-1111-4111-8111-111111111111","method":"bridge.hello","params":{"supportedVersions":[1]}}
        """.utf8))
        #expect(writer.emit(event))

        let frames = output.lines
        #expect(frames.count == 1)
        let decoded = try JSONDecoder().decode(BridgeEvent.self, from: frames[0])
        #expect(decoded.seq == 0)
        #expect(decoded.event == .callStateChanged)
        #expect(diagnostics.data.isEmpty)
    }

    @Test func concurrentResponsesAndEventsRemainWholeAtomicJSONLines() throws {
        let output = ByteYieldingDataWriter()
        let diagnostics = CapturingDataWriter()
        let writer = SynchronizedJSONLFrameWriter(output: output, diagnostics: diagnostics)
        writer.enableEvents()

        DispatchQueue.concurrentPerform(iterations: 100) { index in
            if index.isMultiple(of: 2) {
                let response = BridgeResponse(id: UUID(), result: ["index": .number(Double(index))])
                #expect(writer.writeResponse(response) == .written)
            } else {
                let event = try! BridgeEvent(seq: index, event: .callStateChanged, payload: [
                    "connected": .bool(index.isMultiple(of: 3)),
                ])
                #expect(writer.emit(event))
            }
        }

        #expect(output.lines.count == 100)
        for line in output.lines {
            let object = try JSONSerialization.jsonObject(with: line)
            #expect(object is [String: Any])
        }
        #expect(diagnostics.data.isEmpty)
    }

    @Test func oversizedEventWritesNoPayloadAndLaterResponseRemainsValid() throws {
        let output = CapturingDataWriter()
        let diagnostics = CapturingDataWriter()
        let writer = SynchronizedJSONLFrameWriter(
            codec: JSONLinesCodec(maxFrameBytes: 256),
            output: output,
            diagnostics: diagnostics
        )
        writer.enableEvents()
        let event = try BridgeEvent(seq: 0, event: .capabilityChanged, payload: [
            "private": .string(String(repeating: "x", count: 512)),
        ])

        #expect(!writer.emit(event))
        #expect(output.data.isEmpty)
        #expect(diagnostics.string == "callie-apple-bridge: frame too large\n")

        let response = BridgeResponse(id: UUID(), result: [:])
        #expect(writer.writeResponse(response) == .written)
        #expect(output.lines.count == 1)
        _ = try JSONDecoder().decode(BridgeResponse.self, from: output.lines[0])
    }

    @Test func outputFailureUsesConstantDiagnosticAndDisablesAllLaterFrames() throws {
        let output = AlwaysFailingDataWriter(hostileError: "private-handle@example.invalid")
        let diagnostics = CapturingDataWriter()
        let writer = SynchronizedJSONLFrameWriter(output: output, diagnostics: diagnostics)
        writer.enableEvents()
        let event = try BridgeEvent(seq: 0, event: .callIdentityResolved, payload: [
            "identity": .string("resolved"),
        ])

        #expect(!writer.emit(event))
        #expect(writer.writeResponse(BridgeResponse(id: UUID(), result: [:])) == .terminalFailure)

        #expect(output.attempts == 1)
        #expect(diagnostics.string == "callie-apple-bridge: output failure\n")
        #expect(!diagnostics.string.contains("private-handle"))
    }

    @Test func serverRunWritesResponsesAndObservationEventThroughSameJSONLWriter() async throws {
        let output = CapturingDataWriter()
        let diagnostics = CapturingDataWriter()
        let writer = SynchronizedJSONLFrameWriter(output: output, diagnostics: diagnostics)
        let handler = EventDuringStartHandler(emitter: writer)
        let server = StdioBridgeServer(handler: handler, frameWriter: writer)
        let input = Pipe()
        let requests = Data(("""
        {"v":1,"kind":"request","id":"11111111-1111-4111-8111-111111111111","method":"bridge.hello","params":{"supportedVersions":[1]}}
        {"v":1,"kind":"request","id":"22222222-2222-4222-8222-222222222222","method":"call.observe.start","params":{}}
        {"v":1,"kind":"request","id":"33333333-3333-4333-8333-333333333333","method":"bridge.shutdown","params":{}}
        """ + "\n").utf8)
        try input.fileHandleForWriting.write(contentsOf: requests)
        try input.fileHandleForWriting.close()

        await server.run(input: input.fileHandleForReading)

        let lines = output.lines
        try #require(lines.count == 4)
        let objects = try lines.map { line in
            try #require(JSONSerialization.jsonObject(with: line) as? [String: Any])
        }
        #expect(objects[0]["kind"] as? String == "response")
        #expect(objects[0]["id"] as? String == "11111111-1111-4111-8111-111111111111")
        #expect(objects[1]["kind"] as? String == "event")
        #expect(objects[1]["seq"] as? Int == 0)
        #expect(objects[1]["event"] as? String == "call.stateChanged")
        #expect(objects[2]["kind"] as? String == "response")
        #expect(objects[2]["id"] as? String == "22222222-2222-4222-8222-222222222222")
        #expect(objects[3]["kind"] as? String == "response")
        #expect(objects[3]["id"] as? String == "33333333-3333-4333-8333-333333333333")
        #expect(diagnostics.data.isEmpty)
    }
}

private final class EventDuringStartHandler: BridgeCommandHandling, @unchecked Sendable {
    private let emitter: any BridgeEventEmitting

    init(emitter: any BridgeEventEmitting) { self.emitter = emitter }

    func handle(_ request: BridgeRequest) async -> BridgeResponse {
        switch request.method {
        case .hello:
            return await BoundedBridgeCommandHandler().handle(request)
        case .startCallObservation:
            let event = try! BridgeEvent(seq: 0, event: .callStateChanged, payload: [
                "outgoing": .bool(true),
                "connected": .bool(true),
                "ended": .bool(false),
                "onHold": .bool(false),
            ])
            _ = emitter.emit(event)
            return BridgeResponse(id: request.id, result: ["observing": .bool(true)])
        case .shutdown:
            return await BoundedBridgeCommandHandler().handle(request)
        default:
            return BridgeResponse(id: request.id, result: [:])
        }
    }
}

private final class CapturingDataWriter: BridgeDataWriting, @unchecked Sendable {
    private let lock = NSLock()
    private var storage = Data()
    var data: Data { lock.withLock { storage } }
    var string: String { String(decoding: data, as: UTF8.self) }
    var lines: [Data] {
        Array(data).split(separator: UInt8(0x0A)).map { Data($0) }
    }

    func write(_ data: Data) throws {
        lock.withLock { storage.append(data) }
    }
}

private final class ByteYieldingDataWriter: BridgeDataWriting, @unchecked Sendable {
    private let lock = NSLock()
    private var storage = Data()
    var lines: [Data] { lock.withLock { Array(storage).split(separator: UInt8(0x0A)).map { Data($0) } } }

    func write(_ data: Data) throws {
        for byte in data {
            lock.withLock { storage.append(byte) }
            sched_yield()
        }
    }
}

private final class AlwaysFailingDataWriter: BridgeDataWriting, @unchecked Sendable {
    struct SyntheticFailure: Error { let detail: String }
    private let lock = NSLock()
    private let hostileError: String
    private var count = 0
    var attempts: Int { lock.withLock { count } }

    init(hostileError: String) { self.hostileError = hostileError }

    func write(_ data: Data) throws {
        lock.withLock { count += 1 }
        throw SyntheticFailure(detail: hostileError)
    }
}
