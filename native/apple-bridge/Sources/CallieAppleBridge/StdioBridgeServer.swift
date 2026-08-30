import CallieAppleCore
import CallieAppleProtocol
import Foundation

public actor StdioBridgeServer {
    private let codec: JSONLinesCodec
    private let handler: any BridgeCommandHandling
    private let frameWriter: any BridgeServerFrameWriting
    private var receivedRequestIDs: Set<UUID> = []
    private var hasReceivedHello = false
    private var isShutdownRequested = false
    private var pendingRequests: [(BridgeRequest, CheckedContinuation<BridgeResponse, Never>)] = []
    private var isProcessingRequest = false

    public init(
        handler: any BridgeCommandHandling = BoundedBridgeCommandHandler(),
        codec: JSONLinesCodec = JSONLinesCodec()
    ) {
        self.handler = handler
        self.codec = codec
        frameWriter = SynchronizedJSONLFrameWriter(codec: codec)
    }

    init(
        handler: any BridgeCommandHandling,
        codec: JSONLinesCodec = JSONLinesCodec(),
        frameWriter: any BridgeServerFrameWriting
    ) {
        self.handler = handler
        self.codec = codec
        self.frameWriter = frameWriter
    }

    public func processLine(_ data: Data) async throws -> BridgeResponse {
        let request = try codec.decodeLine(data)

        return await withCheckedContinuation { continuation in
            pendingRequests.append((request, continuation))
            guard !isProcessingRequest else { return }
            isProcessingRequest = true
            Task { await self.drainPendingRequests() }
        }
    }

    private func drainPendingRequests() async {
        while !pendingRequests.isEmpty {
            let (request, continuation) = pendingRequests.removeFirst()
            continuation.resume(returning: await processRequest(request))
        }
        isProcessingRequest = false
    }

    private func processRequest(_ request: BridgeRequest) async -> BridgeResponse {
        guard receivedRequestIDs.insert(request.id).inserted else {
            return invalidRequestResponse(id: request.id)
        }
        guard !(hasReceivedHello && request.method == .hello) else {
            return invalidRequestResponse(id: request.id)
        }
        guard hasReceivedHello || request.method == .hello else {
            return handshakeRequiredResponse(id: request.id)
        }

        let response = await handler.handle(request)
        if request.method == .hello, response.ok {
            hasReceivedHello = true
            frameWriter.enableEvents()
        }
        if request.method == .shutdown, response.ok {
            isShutdownRequested = true
            frameWriter.disableEvents()
        }
        return response
    }

    public func run(
        input: FileHandle = .standardInput
    ) async {
        var line = Data()
        var discardingOversizedLine = false

        do {
            while let chunk = try input.read(upToCount: 4_096), !chunk.isEmpty {
                for byte in chunk {
                    if discardingOversizedLine {
                        if byte == 0x0A { discardingOversizedLine = false }
                        continue
                    }
                    if byte == 0x0A {
                        guard await writeResponse(for: line) else { return }
                        line.removeAll(keepingCapacity: true)
                        if isShutdownRequested { return }
                        continue
                    }

                    line.append(byte)
                    if line.count + 1 > codec.maxFrameBytes {
                        line.removeAll(keepingCapacity: true)
                        discardingOversizedLine = true
                        frameWriter.writeDiagnostic(.frameTooLarge)
                    }
                }
            }
        } catch {
            frameWriter.writeDiagnostic(.inputFailure)
        }

        if !line.isEmpty && !discardingOversizedLine {
            frameWriter.writeDiagnostic(.invalidFrame)
        }
    }

    private func writeResponse(for line: Data) async -> Bool {
        do {
            let response = try await processLine(line)
            return frameWriter.writeResponse(response) != .terminalFailure
        } catch JSONLinesCodecError.frameTooLarge {
            frameWriter.writeDiagnostic(.frameTooLarge)
        } catch JSONLinesCodecError.invalidUTF8 {
            frameWriter.writeDiagnostic(.invalidFrame)
        } catch {
            frameWriter.writeDiagnostic(.invalidFrame)
        }
        return true
    }

    private func invalidRequestResponse(id: UUID) -> BridgeResponse {
        errorResponse(id: id, code: .invalidRequest, message: "Request ID has already been used.")
    }

    private func handshakeRequiredResponse(id: UUID) -> BridgeResponse {
        errorResponse(id: id, code: .protocolMismatch, message: "Protocol V1 handshake is required.")
    }

    private func errorResponse(id: UUID, code: BridgeErrorCode, message: String) -> BridgeResponse {
        guard let error = try? BridgeErrorPayload(code: code, message: message, retryable: false) else {
            fatalError("Invalid constant bridge error payload")
        }
        return BridgeResponse(id: id, error: error)
    }
}
