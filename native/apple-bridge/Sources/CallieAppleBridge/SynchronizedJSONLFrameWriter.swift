import CallieAppleCore
import CallieAppleProtocol
import Foundation

enum BridgeFrameWriteResult: Equatable {
    case written
    case dropped
    case terminalFailure
}

enum BridgeFixedDiagnostic {
    case frameTooLarge
    case invalidFrame
    case inputFailure
    case outputFailure

    var data: Data {
        switch self {
        case .frameTooLarge: Data("callie-apple-bridge: frame too large\n".utf8)
        case .invalidFrame: Data("callie-apple-bridge: invalid frame\n".utf8)
        case .inputFailure: Data("callie-apple-bridge: input failure\n".utf8)
        case .outputFailure: Data("callie-apple-bridge: output failure\n".utf8)
        }
    }
}

protocol BridgeDataWriting: Sendable {
    func write(_ data: Data) throws
}

protocol BridgeServerFrameWriting: BridgeEventEmitting {
    func enableEvents()
    func disableEvents()
    func writeResponse(_ response: BridgeResponse) -> BridgeFrameWriteResult
    func writeDiagnostic(_ diagnostic: BridgeFixedDiagnostic)
}

final class FileHandleBridgeDataWriter: BridgeDataWriting, @unchecked Sendable {
    private let fileHandle: FileHandle

    init(_ fileHandle: FileHandle) {
        self.fileHandle = fileHandle
    }

    func write(_ data: Data) throws {
        try fileHandle.write(contentsOf: data)
    }
}

final class SynchronizedJSONLFrameWriter: BridgeServerFrameWriting, @unchecked Sendable {
    private let codec: JSONLinesCodec
    private let output: any BridgeDataWriting
    private let diagnostics: any BridgeDataWriting
    private let lock = NSLock()
    private var eventsEnabled = false
    private var outputFailed = false

    convenience init(codec: JSONLinesCodec = JSONLinesCodec()) {
        self.init(
            codec: codec,
            output: FileHandleBridgeDataWriter(.standardOutput),
            diagnostics: FileHandleBridgeDataWriter(.standardError)
        )
    }

    init(
        codec: JSONLinesCodec = JSONLinesCodec(),
        output: any BridgeDataWriting,
        diagnostics: any BridgeDataWriting
    ) {
        self.codec = codec
        self.output = output
        self.diagnostics = diagnostics
    }

    func enableEvents() {
        lock.withLock {
            guard !outputFailed else { return }
            eventsEnabled = true
        }
    }

    func disableEvents() {
        lock.withLock { eventsEnabled = false }
    }

    func writeResponse(_ response: BridgeResponse) -> BridgeFrameWriteResult {
        lock.withLock {
            guard !outputFailed else { return .terminalFailure }
            return write(response)
        }
    }

    func emit(_ event: BridgeEvent) -> Bool {
        lock.withLock {
            guard eventsEnabled, !outputFailed else { return false }
            return write(event) == .written
        }
    }

    func writeDiagnostic(_ diagnostic: BridgeFixedDiagnostic) {
        lock.withLock { writeDiagnosticWhileLocked(diagnostic) }
    }

    private func write<Value: Encodable>(_ value: Value) -> BridgeFrameWriteResult {
        do {
            let frame = try codec.encodeLine(value)
            do {
                try output.write(frame)
                return .written
            } catch {
                outputFailed = true
                eventsEnabled = false
                writeDiagnosticWhileLocked(.outputFailure)
                return .terminalFailure
            }
        } catch JSONLinesCodecError.frameTooLarge {
            writeDiagnosticWhileLocked(.frameTooLarge)
            return .dropped
        } catch {
            writeDiagnosticWhileLocked(.invalidFrame)
            return .dropped
        }
    }

    private func writeDiagnosticWhileLocked(_ diagnostic: BridgeFixedDiagnostic) {
        try? diagnostics.write(diagnostic.data)
    }
}
