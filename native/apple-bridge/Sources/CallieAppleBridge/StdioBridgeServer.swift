import CallieAppleCore
import CallieAppleProtocol
import Foundation

public actor StdioBridgeServer {
    private let codec: JSONLinesCodec
    private let handler: any BridgeCommandHandling
    private var receivedRequestIDs: Set<UUID> = []
    private var hasReceivedHello = false
    private var isShutdownRequested = false

    public init(
        handler: any BridgeCommandHandling = BoundedBridgeCommandHandler(),
        codec: JSONLinesCodec = JSONLinesCodec()
    ) {
        self.handler = handler
        self.codec = codec
    }

    public func processLine(_ data: Data) throws -> BridgeResponse {
        let request = try codec.decodeLine(data)

        guard receivedRequestIDs.insert(request.id).inserted else {
            return invalidRequestResponse(id: request.id)
        }
        guard !(hasReceivedHello && request.method == .hello) else {
            return invalidRequestResponse(id: request.id)
        }
        guard hasReceivedHello || request.method == .hello else {
            return handshakeRequiredResponse(id: request.id)
        }

        let response = handler.handle(request)
        if request.method == .hello, response.ok {
            hasReceivedHello = true
        }
        if request.method == .shutdown, response.ok {
            isShutdownRequested = true
        }
        return response
    }

    public func run(
        input: FileHandle = .standardInput,
        output: FileHandle = .standardOutput,
        errorOutput: FileHandle = .standardError
    ) {
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
                        writeResponse(for: line, to: output, errorOutput: errorOutput)
                        line.removeAll(keepingCapacity: true)
                        if isShutdownRequested { return }
                        continue
                    }

                    line.append(byte)
                    if line.count + 1 > codec.maxFrameBytes {
                        line.removeAll(keepingCapacity: true)
                        discardingOversizedLine = true
                        writeDiagnostic("callie-apple-bridge: frame too large\n", to: errorOutput)
                    }
                }
            }
        } catch {
            writeDiagnostic("callie-apple-bridge: input failure\n", to: errorOutput)
        }

        if !line.isEmpty && !discardingOversizedLine {
            writeDiagnostic("callie-apple-bridge: invalid frame\n", to: errorOutput)
        }
    }

    private func writeResponse(for line: Data, to output: FileHandle, errorOutput: FileHandle) {
        do {
            let response = try processLine(line)
            output.write(try codec.encodeLine(response))
        } catch JSONLinesCodecError.frameTooLarge {
            writeDiagnostic("callie-apple-bridge: frame too large\n", to: errorOutput)
        } catch JSONLinesCodecError.invalidUTF8 {
            writeDiagnostic("callie-apple-bridge: invalid frame\n", to: errorOutput)
        } catch {
            writeDiagnostic("callie-apple-bridge: invalid frame\n", to: errorOutput)
        }
    }

    private func writeDiagnostic(_ message: String, to errorOutput: FileHandle) {
        errorOutput.write(Data(message.utf8))
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
