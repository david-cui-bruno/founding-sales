import CallieAppleProtocol
import Foundation

public struct FeasibilityBridgeCommandHandler: BridgeCommandHandling {
    private let notesScanner: any NotesRecordingScanning
    private let notesExporter: any NotesAttachmentExporting
    private let messageSender: any MessageTestSending
    private let messageActivityScanner: any MessageTestActivityScanning
    private let feasibilityController: any AppleFeasibilityControlling
    private let now: @Sendable () -> Date
    private let shutdown: @Sendable () async throws -> Void
    private let attemptedCommands: AttemptedMessageCommandRegistry
    private let fallback = BoundedBridgeCommandHandler()

    public init(
        notesScanner: any NotesRecordingScanning,
        notesExporter: any NotesAttachmentExporting,
        messageSender: any MessageTestSending,
        messageActivityScanner: any MessageTestActivityScanning,
        feasibilityController: any AppleFeasibilityControlling = UnavailableAppleFeasibilityController(),
        attemptedCommandCapacity: Int = 1_024,
        now: @escaping @Sendable () -> Date = Date.init,
        shutdown: @escaping @Sendable () async throws -> Void = {}
    ) {
        self.notesScanner = notesScanner
        self.notesExporter = notesExporter
        self.messageSender = messageSender
        self.messageActivityScanner = messageActivityScanner
        self.feasibilityController = feasibilityController
        attemptedCommands = AttemptedMessageCommandRegistry(capacity: attemptedCommandCapacity)
        self.now = now
        self.shutdown = shutdown
    }

    public func handle(_ request: BridgeRequest) async -> BridgeResponse {
        do {
            switch request.params {
            case .probeCapabilities:
                let capabilities = await feasibilityController.probeCapabilities()
                return BridgeResponse(id: request.id, result: [
                    "capabilities": .object([
                        "contacts": .string(Self.contactAccessWireValue(capabilities.contacts)),
                        "accessibility": .string(Self.accessibilityAccessWireValue(capabilities.accessibility)),
                        "callObservationAvailable": .bool(capabilities.callObservationAvailable),
                        "recordingControlAvailable": .bool(capabilities.recordingControlAvailable),
                    ]),
                ])
            case .requestContacts:
                let access = try await feasibilityController.requestContactAccess()
                return BridgeResponse(id: request.id, result: [
                    "access": .string(Self.contactAccessWireValue(access)),
                ])
            case .promptAccessibility:
                let trusted = await feasibilityController.promptForAccessibility()
                return BridgeResponse(id: request.id, result: ["trusted": .bool(trusted)])
            case .startCallObservation:
                let observing = try await feasibilityController.startCallObservation()
                return BridgeResponse(id: request.id, result: ["observing": .bool(observing)])
            case .stopCallObservation:
                let observing = await feasibilityController.stopCallObservation()
                return BridgeResponse(id: request.id, result: ["observing": .bool(observing)])
            case .scanCallRecordings:
                let scan = try notesScanner.scan(since: now().addingTimeInterval(-86_400))
                return BridgeResponse(id: request.id, result: [
                    "artifacts": .array(scan.artifacts.map { artifact in
                        .object([
                            "artifactId": .string(artifact.id.value.uuidString.lowercased()),
                            "createdAt": .string(Self.timestamp(artifact.createdAt)),
                        ])
                    }),
                    "truncated": .bool(scan.truncated),
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
                switch attemptedCommands.markAttempted(parameters.commandId) {
                case .accepted:
                    break
                case .duplicate:
                    return errorResponse(id: request.id, code: .invalidRequest, message: "The message command ID was already attempted.")
                case .full:
                    return errorResponse(id: request.id, code: .capabilityUnavailable, message: "The message command registry is full until restart.")
                }
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
                _ = await feasibilityController.stopCallObservation()
                try await shutdown()
                return await fallback.handle(request)
            default:
                return await fallback.handle(request)
            }
        } catch is BridgeShutdownError {
            return errorResponse(
                id: request.id,
                code: .internalError,
                message: "Bridge shutdown cleanup could not be verified."
            )
        } catch let error as NotesPortError {
            return notesError(error, id: request.id)
        } catch let error as MessagesSendPortError {
            return messagesSendError(error, id: request.id)
        } catch let error as MessagesReadPortError {
            return messagesReadError(error, id: request.id)
        } catch let error as AppleFeasibilityControlError {
            return feasibilityControlError(error, id: request.id)
        } catch {
            return errorResponse(id: request.id, code: .internalError, message: "The fixed feasibility operation failed.")
        }
    }

    private static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private static func contactAccessWireValue(_ access: ContactAccess) -> String {
        switch access {
        case .full: "full"
        case .limited: "limited"
        case .denied: "denied"
        case .restricted: "restricted"
        case .notDetermined: "notDetermined"
        }
    }

    private static func accessibilityAccessWireValue(_ access: AccessibilityAccess) -> String {
        switch access {
        case .granted: "granted"
        case .denied: "denied"
        case .notDetermined: "notDetermined"
        }
    }

    private func notesError(_ error: NotesPortError, id: UUID) -> BridgeResponse {
        switch error {
        case .artifactNotFound:
            errorResponse(id: id, code: .artifactNotFound, message: "The opaque Notes artifact was not found.")
        case .capabilityUnavailable, .invalidReply:
            errorResponse(id: id, code: .capabilityUnavailable, message: "The fixed Notes operation is unavailable.")
        case .exportFailed, .cleanupFailed:
            errorResponse(id: id, code: .internalError, message: "The Notes export proof could not be completed.")
        case .plaintextRetentionRisk:
            errorResponse(id: id, code: .internalError, message: "The Notes export was disabled because plaintext deletion could not be verified.")
        }
    }

    private func messagesSendError(_ error: MessagesSendPortError, id: UUID) -> BridgeResponse {
        switch error {
        case .manualConfirmationRequired:
            errorResponse(id: id, code: .invalidRequest, message: "Exact manual confirmation is required.")
        case .invalidRequest:
            errorResponse(id: id, code: .invalidRequest, message: "The fixed test message request is invalid.")
        case .recipientAmbiguous:
            errorResponse(id: id, code: .identityUnresolved, message: "Exactly one Messages participant must match the handle.")
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

    private func feasibilityControlError(_ error: AppleFeasibilityControlError, id: UUID) -> BridgeResponse {
        switch error {
        case .callObservationUnavailable:
            errorResponse(id: id, code: .capabilityUnavailable, message: "Call observation is unavailable.")
        case .permissionRequestFailed:
            errorResponse(id: id, code: .capabilityUnavailable, message: "The permission request could not be completed.")
        }
    }

    private func errorResponse(id: UUID, code: BridgeErrorCode, message: String) -> BridgeResponse {
        guard let error = try? BridgeErrorPayload(code: code, message: message, retryable: false) else {
            fatalError("Invalid constant bridge error payload")
        }
        return BridgeResponse(id: id, error: error)
    }
}

private final class AttemptedMessageCommandRegistry: @unchecked Sendable {
    enum Result { case accepted, duplicate, full }
    private let lock = NSLock()
    private let capacity: Int
    private var attempted: Set<UUID> = []

    init(capacity: Int) { self.capacity = max(0, capacity) }

    func markAttempted(_ id: UUID) -> Result {
        lock.withLock {
            if attempted.contains(id) { return .duplicate }
            guard attempted.count < capacity else { return .full }
            attempted.insert(id)
            return .accepted
        }
    }
}
