import CallieAppleProtocol
import Foundation

public struct FeasibilityBridgeCommandHandler: BridgeCommandHandling {
    private let notesScanner: any NotesRecordingScanning
    private let notesExporter: any NotesAttachmentExporting
    private let messageSender: any MessageTestSending
    private let messageActivityScanner: any MessageTestActivityScanning
    private let now: @Sendable () -> Date
    private let shutdown: @Sendable () -> Void
    private let fallback = BoundedBridgeCommandHandler()

    public init(
        notesScanner: any NotesRecordingScanning,
        notesExporter: any NotesAttachmentExporting,
        messageSender: any MessageTestSending,
        messageActivityScanner: any MessageTestActivityScanning,
        now: @escaping @Sendable () -> Date = Date.init,
        shutdown: @escaping @Sendable () -> Void = {}
    ) {
        self.notesScanner = notesScanner
        self.notesExporter = notesExporter
        self.messageSender = messageSender
        self.messageActivityScanner = messageActivityScanner
        self.now = now
        self.shutdown = shutdown
    }

    public func handle(_ request: BridgeRequest) -> BridgeResponse {
        do {
            switch request.params {
            case .scanCallRecordings:
                let artifacts = try notesScanner.scan(since: now().addingTimeInterval(-86_400))
                return BridgeResponse(id: request.id, result: [
                    "artifacts": .array(artifacts.map { artifact in
                        .object([
                            "artifactId": .string(artifact.id.value.uuidString.lowercased()),
                            "createdAt": .string(Self.timestamp(artifact.createdAt)),
                        ])
                    }),
                ])
            case let .exportCallRecording(parameters):
                let proof = try notesExporter.proveExport(id: NotesArtifactID(parameters.artifactId))
                return BridgeResponse(id: request.id, result: [
                    "artifactId": .string(proof.artifactID.value.uuidString.lowercased()),
                    "byteCount": .number(Double(proof.byteCount)),
                    "sha256": .string(proof.sha256),
                    "plaintextRetained": .bool(proof.plaintextRetained),
                ])
            case let .sendTestMessage(parameters):
                let receipt = try messageSender.sendTest(.init(
                    commandID: parameters.commandId,
                    handle: NormalizedHandle(parameters.recipientHandle),
                    body: parameters.body,
                    confirmation: parameters.confirmation
                ))
                return BridgeResponse(id: request.id, result: [
                    "commandId": .string(receipt.commandID.uuidString.lowercased()),
                ])
            case let .scanTestMessageActivity(parameters):
                let activity = try messageActivityScanner.scanTestActivity(
                    handle: NormalizedHandle(parameters.recipientHandle),
                    since: now().addingTimeInterval(-86_400)
                )
                return BridgeResponse(id: request.id, result: [
                    "sentCount": .number(Double(activity.sentCount)),
                    "receivedCount": .number(Double(activity.receivedCount)),
                    "latestAt": activity.latestAt.map { .string(Self.timestamp($0)) } ?? .null,
                ])
            case .shutdown:
                shutdown()
                return fallback.handle(request)
            default:
                return fallback.handle(request)
            }
        } catch let error as NotesPortError {
            return notesError(error, id: request.id)
        } catch let error as MessagesSendPortError {
            return messagesSendError(error, id: request.id)
        } catch let error as MessagesReadPortError {
            return messagesReadError(error, id: request.id)
        } catch {
            return errorResponse(id: request.id, code: .internalError, message: "The fixed feasibility operation failed.")
        }
    }

    private static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private func notesError(_ error: NotesPortError, id: UUID) -> BridgeResponse {
        switch error {
        case .artifactNotFound:
            errorResponse(id: id, code: .artifactNotFound, message: "The opaque Notes artifact was not found.")
        case .capabilityUnavailable, .invalidReply:
            errorResponse(id: id, code: .capabilityUnavailable, message: "The fixed Notes operation is unavailable.")
        case .exportFailed, .cleanupFailed:
            errorResponse(id: id, code: .internalError, message: "The Notes export proof could not be completed.")
        }
    }

    private func messagesSendError(_ error: MessagesSendPortError, id: UUID) -> BridgeResponse {
        switch error {
        case .manualConfirmationRequired:
            errorResponse(id: id, code: .invalidRequest, message: "Exact manual confirmation is required.")
        case .invalidRequest:
            errorResponse(id: id, code: .invalidRequest, message: "The fixed test message request is invalid.")
        case .sendFailed:
            errorResponse(id: id, code: .capabilityUnavailable, message: "The fixed test message could not be sent.")
        }
    }

    private func messagesReadError(_ error: MessagesReadPortError, id: UUID) -> BridgeResponse {
        switch error {
        case .schemaUnsupported:
            errorResponse(id: id, code: .schemaUnsupported, message: "The Messages database schema is unsupported.")
        case .databaseUnavailable:
            errorResponse(id: id, code: .capabilityUnavailable, message: "The Messages read store is unavailable.")
        case .queryFailed:
            errorResponse(id: id, code: .internalError, message: "The bounded Messages activity query failed.")
        }
    }

    private func errorResponse(id: UUID, code: BridgeErrorCode, message: String) -> BridgeResponse {
        guard let error = try? BridgeErrorPayload(code: code, message: message, retryable: false) else {
            fatalError("Invalid constant bridge error payload")
        }
        return BridgeResponse(id: id, error: error)
    }
}
