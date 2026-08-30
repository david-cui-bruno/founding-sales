import CallieAppleProtocol
import Foundation

public protocol BridgeCommandHandling: Sendable {
    func handle(_ request: BridgeRequest) -> BridgeResponse
}

public struct BoundedBridgeCommandHandler: BridgeCommandHandling {
    public init() {}

    public func handle(_ request: BridgeRequest) -> BridgeResponse {
        switch request.method {
        case .hello:
            return BridgeResponse(id: request.id, result: ["selectedVersion": .number(1)])
        case .probeCapabilities:
            return BridgeResponse(id: request.id, result: ["capabilities": .object([:])])
        case .shutdown:
            return BridgeResponse(id: request.id, result: ["shuttingDown": .bool(true)])
        default:
            return errorResponse(
                id: request.id,
                code: .capabilityUnavailable,
                message: "This bridge command is unavailable in the bounded server."
            )
        }
    }
}

private func errorResponse(id: UUID, code: BridgeErrorCode, message: String) -> BridgeResponse {
    guard let error = try? BridgeErrorPayload(code: code, message: message, retryable: false) else {
        fatalError("Invalid constant bridge error payload")
    }
    return BridgeResponse(id: id, error: error)
}
